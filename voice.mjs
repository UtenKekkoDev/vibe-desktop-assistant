import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssistant } from './assistant.mjs';
import { VoiceSession } from './voice-session.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const help = `node voice.mjs [--wake 小助手] [--target 完整窗口标题] [--field 输入框名称] [--speak]
  --devices          列出录音设备
  --check-mic        短时间检查麦克风能否采集音频帧，不保存音频
  --device 编号       选择录音设备，默认使用系统输入
  --model 目录        指定 SenseVoice 模型目录
  --wav 音频文件      顺序回放音频并实际执行识别出的指令，使用专用测试窗口
  --before/--after    指定两份预算，沿用文字入口的操作方式
说“小助手”唤醒，“停一下”取消待执行动作，“休眠”回到待命，“关闭麦克风”结束进程。`;

function windowsSpeaker(enabled) {
  let child = null;
  let quietAfter = 0;
  let spoken = '';
  function hush() {
    if (child) {
      child.kill();
      child = null;
      quietAfter = Date.now() + 600;
    }
  }
  return {
    hush,
    active: () => Boolean(child) || Date.now() < quietAfter,
    echoes: text => spoken.replace(/[\p{P}\s]/gu, '').includes(text),
    say(text) {
      if (!enabled || !text) return;
      hush();
      spoken = text;
      const next = spawn(path.join(root, '.runtime/venv/Scripts/python.exe'), ['-X', 'utf8', path.join(root, 'voice_feedback.py')],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child = next;
      next.on('error', () => console.error('本地播报不可用，结果仍显示在控制台。'));
      next.once('close', code => {
        if (child === next) {
          child = null;
          quietAfter = Date.now() + 600;
          if (code) console.error('Windows 语音未能播放本次反馈。');
        }
      });
      next.stdin.on('error', () => {});
      next.stdin.end(text);
    },
  };
}

export async function runVoice(options) {
  const python = path.join(root, '.runtime/voice/Scripts/python.exe');
  if (!existsSync(python)) throw new Error('请先运行 setup-voice.ps1 安装本地语音组件。');
  const args = ['-X', 'utf8', path.join(root, 'voice_input.py')];
  if (options.devices) args.push('--list-devices');
  else if (options['check-mic']) {
    args.push('--check-mic');
    if (options.device !== undefined) args.push('--device', options.device);
  }
  else {
    args.push('--model', options.model || path.join(root, '.runtime/sensevoice'));
    if (options.wav) args.push('--wav', path.resolve(options.wav));
    if (options.device !== undefined) args.push('--device', options.device);
    for (const flag of ['threshold', 'silence-ms']) if (options[flag]) args.push('--' + flag, options[flag]);
  }
  if (options.wav && options.device !== undefined) throw new Error('请选择音频回放或麦克风输入其中一种。');
  const session = createAssistant(options);
  const input = spawn(python, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => {
    input.once('error', error => resolve({ error }));
    input.once('close', code => resolve({ code }));
  });
  const speaker = windowsSpeaker(options.speak);
  const voice = new VoiceSession({
    session, wakeWord: options.wake || '小助手',
    closeMicrophone() { input.kill(); speaker.hush(); },
  });
  const speakingAtStart = new Set();
  const pending = new Set();
  const shutdown = () => { speaker.hush(); voice.close(); input.kill(); };
  process.on('SIGINT', shutdown);
  try {
    const lines = createInterface({ input: input.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'devices') {
        for (const d of event.devices) console.log(`${d.index}  ${d.name}${d.default ? '（默认）' : ''}`);
      } else if (event.type === 'mic-check') {
        console.log(`麦克风“${event.device}”成功采集 ${event.frames} 帧，采样率 ${event.sampleRate} Hz。`);
      } else if (event.type === 'ready') {
        console.log(`已待命。说“${options.wake || '小助手'}”开始。`);
      } else if (event.type === 'start') {
        if (speaker.active()) speakingAtStart.add(event.id);
        else voice.begin(event.id, { foregroundHwnd: event.foregroundHwnd });
      } else if (event.type === 'error') {
        if (event.id != null) { speakingAtStart.delete(event.id); voice.discard(event.id); }
        if (!event.recoverable) throw new Error(event.message);
        console.error(event.message);
      } else if (event.type === 'text') {
        if (speakingAtStart.delete(event.id) || speaker.active()) {
          voice.discard(event.id);
          const control = event.text.replace(/[\p{P}\s]/gu, '');
          if (!speaker.echoes(control)) {
            if (control === '别念了' || control === '停止朗读') speaker.hush();
            else if (control === '停一下') { speaker.hush(); console.log(voice.stop().message); }
            else if (control === '关闭麦克风') { console.log(voice.close().message); }
          }
          continue;
        }
        const done = voice.finish(event.id, event.text).then(result => {
          if (!result.message) return;
          console.log(result.message);
          if (result.status === 'sleeping' || (voice.state === 'listening' && result.status !== 'busy')) {
            speaker.say(result.status === 'compared' ? '预算比较完成，明细已经显示。' : result.message);
          }
        }).catch(error => console.error(error.message));
        if (options.wav) await done;
        else {
          pending.add(done);
          done.finally(() => pending.delete(done));
        }
      }
    }
    const exit = await exited;
    if (exit.error || (exit.code !== 0 && voice.state !== 'closed')) {
      throw exit.error || new Error('录音或识别进程已退出，请检查设备和模型。');
    }
    await Promise.all(pending);
  } finally {
    process.off('SIGINT', shutdown);
    shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      target: { type: 'string' }, field: { type: 'string' }, 'send-button': { type: 'string' },
      before: { type: 'string' }, after: { type: 'string' }, model: { type: 'string' },
      wake: { type: 'string' }, wav: { type: 'string' }, device: { type: 'string' },
      devices: { type: 'boolean' }, 'check-mic': { type: 'boolean' },
      threshold: { type: 'string' }, 'silence-ms': { type: 'string' },
      speak: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log(help);
    else await runVoice(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
