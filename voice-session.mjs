import { randomUUID } from 'node:crypto';

const ignored = () => ({ status: 'ignored', message: '' });
const isStop = /^(?:停一下|停下|停止|停止执行|先别做了|取消这次)$/u;

function wakePattern(word) {
  const literal = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = /[a-z\d]$/i.test(word) ? '(?![a-z0-9])' : '';
  return new RegExp('^' + literal + boundary + '[\\s，,。.!！：:、？?]*', 'iu');
}

export class VoiceSession {
  #session;
  #wake;
  #state = 'standby';
  #onState;
  #closeMicrophone;
  #streamId = randomUUID();
  #sequence = 0;
  #lastFinal = 0;
  #seen = new Set();
  #segments = new Map();
  #operation = null;

  constructor({ session, wakeWord = '小助手', onState, closeMicrophone }) {
    if (!session || typeof wakeWord !== 'string' || !wakeWord.trim()) {
      throw new Error('请指定桌面会话和非空唤醒词。');
    }
    this.#session = session;
    this.#wake = wakePattern(wakeWord.trim());
    this.#onState = onState;
    this.#closeMicrophone = closeMicrophone;
  }

  get state() { return this.#state; }

  #transition(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState?.(state);
  }

  // id identifies one complete local VAD segment, including its final ASR result.
  begin(id, { foregroundHwnd } = {}) {
    if (id == null || this.#state === 'closed' || this.#seen.has(id)) return;
    this.#seen.add(id);
    const controller = new AbortController();
    // Convert rejections immediately: casual speech can be discarded without
    // ever awaiting the local snapshot. No transcript is sent by this step.
    const binding = this.#session.captureAtStart({ signal: controller.signal, foregroundHwnd })
      .then(value => ({ value }), error => ({ error }));
    this.#segments.set(id, { sequence: ++this.#sequence, controller, binding, foregroundHwnd, final: false });
  }

  discard(id) {
    const segment = this.#segments.get(id);
    if (segment) {
      this.#segments.delete(id);
      segment.controller.abort();
    }
  }

  stop() {
    const wasPreparing = this.#operation !== null;
    for (const id of this.#segments.keys()) this.discard(id);
    this.#operation = null;
    const reply = this.#session.stop();
    if (wasPreparing && reply.status === 'idle') return { status: 'stopped', message: '已取消待执行的指令。' };
    return reply;
  }

  sleep() {
    if (this.#state === 'closed') return ignored();
    const stopped = this.stop();
    this.#transition('standby');
    return { status: 'sleeping', message: stopped.status === 'stopping'
      ? '已休眠，正在核对已经发起的动作。' : '已休眠。' };
  }

  close() {
    if (this.#state === 'closed') return ignored();
    this.stop();
    this.#transition('closed');
    this.#closeMicrophone?.();
    return { status: 'closed', message: '已关闭麦克风。' };
  }

  async finish(id, transcript) {
    const segment = this.#segments.get(id);
    if (!segment || segment.final) return ignored();
    segment.final = true;
    try {
      if (segment.sequence < this.#lastFinal || typeof transcript !== 'string' || !transcript.trim()) {
        return ignored();
      }
      this.#lastFinal = segment.sequence;
      let text = transcript.trim();
      const wake = this.#wake.exec(text);
      if (this.#state === 'standby' && !wake) return ignored();
      if (wake) {
        this.#transition('listening');
        text = text.slice(wake[0].length).trim();
        if (!text) return { status: 'awake', message: '我在听。' };
      }
      // Only whole-utterance controls are local. Quoting a control as part
      // of a longer dictation must leave the user's original text intact.
      const control = text.replace(/[\s。！!？?.]+$/u, '');
      if (isStop.test(control)) return this.stop();
      if (/^(?:先别发|别发了|先不要发送)$/u.test(control)
          && (this.#operation || this.#session.status().status === 'busy')) return this.stop();
      if (/^(?:休眠|进入休眠|先休眠)$/u.test(control)) return this.sleep();
      if (/^(?:关闭麦克风|关麦|关闭话筒)$/u.test(control)) return this.close();

      if (this.#operation || this.#session.status().status === 'busy') {
        return { status: 'busy', message: '上一条指令正在处理，可以说“停一下”。' };
      }
      this.#operation = segment;
      const captured = await segment.binding;
      if (segment.controller.signal.aborted) return ignored();
      if (captured.error) throw captured.error;
      return await this.#session.handle(text, {
        id: this.#streamId + ':' + segment.sequence,
        initialBinding: captured.value,
        windowHandle: segment.foregroundHwnd,
      });
    } catch (error) {
      return { status: 'error', message: error.message || '语音指令处理失败。' };
    } finally {
      if (this.#operation === segment) this.#operation = null;
      this.discard(id);
    }
  }
}
