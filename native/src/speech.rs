//! Persistent local speech worker: stdio, cancellable audio and owned lifetime.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    time::{Duration, Instant},
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
pub(crate) struct WorkerJob {
    _handle: OwnedHandle,
}
impl WorkerJob {
    pub(crate) fn attach(child: &Child) -> Result<Self> {
        let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if h.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let job = Self {
            _handle: unsafe { OwnedHandle::from_raw_handle(h) },
        };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(h, child.as_raw_handle() as _) } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(job)
    }
}
pub struct SpeechOutput {
    child: Option<Child>,
    input: Option<Sender<Value>>,
    events: Option<Receiver<Value>>,
    job: Option<WorkerJob>,
    request: u64,
    pub output_times: Vec<crate::latency::OutputMark>,
    active: Option<Instant>,
    started: Instant,
    ready: bool,
    engine_label: String,
    pub status: String,
}
impl Default for SpeechOutput {
    fn default() -> Self {
        Self {
            child: None,
            input: None,
            events: None,
            job: None,
            request: 0,
            output_times: Vec::new(),
            active: None,
            started: Instant::now(),
            ready: false,
            engine_label: String::new(),
            status: "语音播报已关闭".into(),
        }
    }
}
fn runtime_dir() -> PathBuf {
    std::env::var_os("VIBE_DESKTOP_TTS_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap_or_default()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("tts")
        })
}
#[derive(serde::Deserialize)]
pub struct VoiceOption {
    pub id: String,
    pub label: String,
}

pub fn voice_options() -> Vec<VoiceOption> {
    let Ok(bytes) = std::fs::read(runtime_dir().join("runtime.json")) else {
        return Vec::new();
    };
    #[derive(serde::Deserialize)]
    struct Runtime {
        engine: Option<String>,
        #[serde(default)]
        voices: Vec<VoiceOption>,
    }
    match serde_json::from_slice::<Runtime>(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes)) {
        Ok(config) if config.engine.as_deref() == Some("v5_turbo") => config.voices,
        _ => Vec::new(),
    }
}

impl SpeechOutput {
    pub fn is_speaking_or_queued(&self) -> bool {
        self.active.is_some()
    }

    pub fn start(&mut self) -> Result<()> {
        if self.child.is_some() {
            return Ok(());
        }
        let dir = runtime_dir();
        let bytes = std::fs::read(dir.join("runtime.json")).context("缺少 语音运行配置")?;
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let config: Value = serde_json::from_slice(bytes).context("语音运行配置无效")?;
        let python = PathBuf::from(config["python"].as_str().context("未配置语音运行环境")?);
        let python = if python.is_absolute() {
            python
        } else {
            dir.join(python)
        };
        if !python.is_file() || !dir.join("worker.py").is_file() {
            bail!("语音运行文件不存在");
        }
        let cache = crate::config::data_dir().join("tts-cache");
        let temp = cache.join("temp");
        std::fs::create_dir_all(&temp).context("无法准备桌面助手语音临时目录")?;
        let mut child = Command::new(python)
            .args(["-u", "-X", "utf8"])
            .arg(dir.join("worker.py"))
            .current_dir(&dir)
            .env("PYTHONUTF8", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("TEMP", &temp)
            .env("TMP", &temp)
            .env("TORCH_HOME", cache.join("torch"))
            .env("TORCHINDUCTOR_CACHE_DIR", cache.join("torchinductor"))
            .env("TRITON_CACHE_DIR", cache.join("triton"))
            .env("CUDA_CACHE_PATH", cache.join("cuda"))
            .env("HF_HOME", cache.join("huggingface"))
            .env("FQWEN3TTS_QWENTTS_REF_CACHE_DIR", cache.join("voice-ref"))
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("无法启动 语音后台")?;
        let job = match WorkerJob::attach(&child) {
            Ok(job) => job,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.context("无法管理语音后台生命周期"));
            }
        };
        let output = child.stdout.take().context("语音响应管道不可用")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && tx.send(v).is_err()
                {
                    break;
                }
            }
        });
        let mut input = child.stdin.take().context("语音指令管道不可用")?;
        let (commands, pending) = mpsc::channel::<Value>();
        // Loading or a stalled worker must never block the GUI on a full pipe.
        // Shutdown kills the child, unblocking any outstanding pipe write.
        std::thread::spawn(move || {
            for command in pending {
                if serde_json::to_writer(&mut input, &command).is_err()
                    || input.write_all(b"\n").is_err()
                    || input.flush().is_err()
                {
                    break;
                }
            }
        });
        self.input = Some(commands);
        self.child = Some(child);
        self.job = Some(job);
        self.events = Some(rx);
        self.started = Instant::now();
        self.ready = false;
        self.engine_label = match config["engine"].as_str() {
            Some("v5_turbo") => "V5 Turbo",
            _ => "Qwen 1.7B · Serena",
        }.into();
        self.status = format!("正在加载 {}…", self.engine_label);
        crate::config::lifecycle("tts worker started");
        Ok(())
    }
    fn send(&mut self, v: Value) -> Result<()> {
        self.input
            .as_ref()
            .context("语音后台未启动")?
            .send(v)
            .context("语音指令管道已关闭")
    }
    pub fn speak(&mut self, text: &str, voice: &str) -> Result<u64> {
        if text.trim().is_empty() || text.chars().count() > 500 {
            bail!("播报内容为空或过长，请查看文字结果");
        }
        self.start()?;
        self.request += 1;
        self.send(json!({"cmd":"speak","id":self.request,"text":text,"voice":voice}))?;
        self.active = Some(Instant::now());
        self.status = if self.ready {
            "正在准备播报…"
        } else {
            "语音模型加载中，稍后播报…"
        }
        .into();
        Ok(self.request)
    }
    pub fn stop(&mut self) {
        self.request += 1;
        self.active = None;
        if self.child.is_some() {
            if self.send(json!({"cmd":"stop","id":self.request})).is_err() {
                self.shutdown();
            } else if self.ready {
                self.status = format!("{} · 就绪", self.engine_label);
            }
        }
    }
    pub fn poll(&mut self) -> Result<()> {
        let events: Vec<Value> = self
            .events
            .as_ref()
            .map(|r| r.try_iter().collect())
            .unwrap_or_default();
        for e in events {
            let current = e["id"].as_u64() == Some(self.request);
            match e["event"].as_str().unwrap_or("") {
                "ready" => {
                    self.ready = true;
                    self.status = if e["output_available"].as_bool() == Some(false) {
                        "语音模型已就绪，请连接输出设备后试听".to_owned()
                    } else {
                        format!("{} · 就绪", self.engine_label)
                    }
                    .into();
                    crate::config::lifecycle("tts ready");
                }
                "first_output" => {
                    if let (Some(request), Some(counter), Some(worker_first)) = (
                        e["id"].as_u64(),
                        e["counter"].as_i64(),
                        e["first_playback"].as_bool(),
                    ) {
                        self.output_times.push(crate::latency::OutputMark {
                            request,
                            counter,
                            worker_first,
                        });
                    }
                }
                "started" if current => {
                    self.status = "正在播报…".into();
                    crate::config::lifecycle(&format!(
                        "tts playing first_pcm_ms={}",
                        e["first_pcm_ms"]
                    ));
                }
                "done" if current => {
                    self.active = None;
                    self.status = format!("{} · 就绪", self.engine_label);
                    crate::config::lifecycle(&format!(
                        "tts done underrun={} driver_errors={}",
                        e["underrun_frames"], e["driver_errors"]
                    ));
                }
                "error" if current => {
                    self.active = None;
                    bail!("{}", e["message"].as_str().unwrap_or("语音播报失败"));
                }
                "fatal" => {
                    self.shutdown();
                    bail!("{}", e["message"].as_str().unwrap_or("语音加载失败"));
                }
                _ => {}
            }
        }
        if let Some(child) = &mut self.child
            && child.try_wait()?.is_some()
        {
            self.shutdown();
            bail!("语音后台已退出，可在设置中重启语音");
        }
        if self.child.is_some() && !self.ready && self.started.elapsed() > Duration::from_secs(90) {
            self.shutdown();
            bail!("语音模型加载超时，可在设置中重试");
        }
        if self
            .active
            .is_some_and(|t| t.elapsed() > Duration::from_secs(90))
        {
            self.shutdown();
            bail!("语音播报超时，文字结果仍保留");
        }
        Ok(())
    }
    pub fn shutdown(&mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.job.take();
        self.events.take();
        self.active = None;
        self.ready = false;
        self.status = "语音播报已关闭".into();
    }
}
impl Drop for SpeechOutput {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires local Qwen GPU runtime and speaker output"]
    fn real_worker_cancels_and_shuts_down() {
        let mut s = SpeechOutput::default();
        s.start().unwrap();
        let stopped = Instant::now();
        // Exceed the pipe buffer while the worker is still loading. Commands
        // and quit must remain responsive even before it reads stdin.
        for _ in 0..500 {
            s.stop();
        }
        s.shutdown();
        assert!(stopped.elapsed() < Duration::from_secs(3));
        s.start().unwrap();
        let deadline = Instant::now() + Duration::from_secs(90);
        while !s.ready {
            s.poll().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        s.speak("需要确认一下，你说的是访问令牌过期，还是刷新令牌过期？", "")
            .unwrap();
        while s.status != "正在播报…" {
            s.poll().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        s.stop();
        assert!(s.active.is_none());
        s.speak("已整理完成。", "").unwrap();
        while s.active.is_some() {
            s.poll().unwrap();
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        s.shutdown();
        assert!(s.child.is_none());
    }
}
