//! Persistent, process-owned desktop session. Only recording onset starts a worker.
use crate::{ai::AiConfig, speech::WorkerJob, task::TaskControl};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    time::Duration,
};

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Receipt>>>>>;

pub(super) struct Receipt {
    pub status: String,
    pub level: Option<super::FeedbackLevel>,
    pub message: String,
}

struct Backend {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    active_turn: u64,
    _job: WorkerJob,
}

static BACKEND: OnceLock<Mutex<Option<Backend>>> = OnceLock::new();
static LAST_ID: AtomicU64 = AtomicU64::new(0);

fn worker() -> &'static Mutex<Option<Backend>> {
    BACKEND.get_or_init(|| Mutex::new(None))
}

fn backend_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dev_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    [exe.parent(), dev_root]
        .into_iter()
        .flatten()
        .map(|root| root.join("native-backend.mjs"))
        .find(|path| path.is_file())
        .context("找不到 native-backend.mjs，请检查桌面助手安装目录。")
}

impl Backend {
    fn spawn() -> Result<Self> {
        let path = backend_path()?;
        let mut child = Command::new("node")
            .arg(&path)
            .current_dir(path.parent().context("桌面助手目录无效。")?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .context("无法启动 Node.js 桌面后端。")?;
        let job = match WorkerJob::attach(&child) {
            Ok(job) => job,
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err.context("无法管理桌面后端生命周期。"));
            }
        };
        let stdin = child.stdin.take().context("无法打开桌面后端输入。")?;
        let stdout = child.stdout.take().context("无法打开桌面后端输出。")?;
        let pending: Pending = Arc::default();
        let replies = Arc::clone(&pending);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                let Some(id) = value["turn"].as_u64() else {
                    break;
                };
                let mut pending = replies.lock().expect("desktop pending lock");
                if value["status"] == "progress" {
                    if let (Some(tx), Some(stage)) = (pending.get(&id), value["stage"].as_str()) {
                        let _ = tx.send(Ok(Receipt { status: "progress".into(), level: None, message: stage.into() }));
                    }
                    continue;
                }
                let tx = pending.remove(&id);
                if let Some(tx) = tx {
                    let receipt = value["status"]
                        .as_str()
                        .zip(value["message"].as_str())
                        .map(|(status, message)| Receipt {
                            status: status.into(),
                            level: value.get("level").and_then(|v| serde_json::from_value(v.clone()).ok()),
                            message: message.into(),
                        })
                        .context("桌面后端返回了无效回执。");
                    let _ = tx.send(receipt);
                }
            }
            for (_, tx) in replies.lock().expect("desktop pending lock").drain() {
                let _ = tx.send(Err(anyhow!("桌面后端连接中断，结果待核对。")));
            }
        });
        Ok(Self {
            child,
            stdin,
            pending,
            active_turn: 0,
            _job: job,
        })
    }

    fn write(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .context("桌面后端连接已关闭。")?;
        self.stdin.flush()?;
        Ok(())
    }
}

pub(super) fn begin(hwnd: Option<isize>) -> Result<u64> {
    let id = LAST_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let mut slot = worker().lock().expect("desktop worker lock");
    if slot
        .as_mut()
        .is_some_and(|b| !matches!(b.child.try_wait(), Ok(None)))
    {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(Backend::spawn()?);
    }
    let backend = slot.as_mut().unwrap();
    backend.active_turn = id;
    backend.write(&json!({"op":"start", "turn":id, "hwnd":hwnd}))?;
    Ok(id)
}

fn stop(id: u64) {
    if let Some(backend) = worker().lock().expect("desktop worker lock").as_mut() {
        backend
            .pending
            .lock()
            .expect("desktop pending lock")
            .remove(&id);
        let _ = backend.write(&json!({"op":"stop", "turn":id}));
    }
}

pub(super) fn finish(
    id: u64,
    text: &str,
    target_unchanged: bool,
    ai: &AiConfig,
    task: &TaskControl,
) -> Result<Receipt> {
    task.check()?;
    let (tx, rx) = mpsc::channel();
    {
        let mut slot = worker().lock().expect("desktop worker lock");
        let backend = slot.as_mut().context("桌面后端没有启动。")?;
        if backend.active_turn != id {
            bail!("录音已过期，未执行。");
        }
        let key = (ai.provider == "DeepSeek"
            && ai.endpoint.trim_end_matches('/') == "https://api.deepseek.com/chat/completions")
            .then_some(&ai.api_key);
        backend
            .pending
            .lock()
            .expect("desktop pending lock")
            .insert(id, tx);
        if let Err(err) = backend.write(&json!({
            "op":"finish", "turn":id, "text":text,
            "targetUnchanged":target_unchanged, "apiKey":key, "wantProgress":true
        })) {
            backend
                .pending
                .lock()
                .expect("desktop pending lock")
                .remove(&id);
            return Err(err);
        }
    }
    loop {
        let remaining = match task.remaining() {
            Ok(time) => time,
            Err(err) => {
                stop(id);
                return Err(err);
            }
        };
        match rx.recv_timeout(remaining.min(Duration::from_millis(25))) {
            Ok(Ok(receipt)) if receipt.status == "progress" => {
                let now = std::time::Instant::now();
                match receipt.message.as_str() {
                    "action" => { let _ = task.desktop_action.set(now); }
                    "submitted" => { let _ = task.search_submitted.set(now); }
                    _ => {}
                }
            }
            Ok(reply) => return reply,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => bail!("未收到桌面操作回执，请核对实际结果。"),
        }
    }
}
