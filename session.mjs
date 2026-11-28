import { randomUUID } from 'node:crypto';

function result(status, message, extra = {}) {
  return { status, message, ...extra };
}

function sameDraft(first, second) {
  return Boolean(first && second && first.identity === second.identity && first.draft === second.draft);
}

// A binding is an adapter-issued descriptor. The adapter must revalidate it at
// the point of mutation and never resolve an obsolete identity by title alone.
export class Session {
  #active = null;
  #requests = new Map();
  #sent = new Map();
  #binding = null;
  #pending = null;
  #selection = null;
  #locate;
  #last = result('ready', '可以开始。');
  #target;
  #decide;
  #capture;
  #apply;

  constructor({ decide, capture, apply, locate, target = null }) {
    this.#locate = locate;
    this.#decide = decide;
    this.#capture = capture;
    this.#apply = apply;
    this.#target = target;
  }

  status() {
    if (this.#active) {
      return result('busy', this.#active.phase === 'effect' ? '正在执行桌面动作。' : '正在处理指令。');
    }
    return this.#last;
  }

  setTarget(target) {
    if (this.#active) return result('busy', '请先停止或等待当前操作结束。');
    this.#target = target;
    this.#binding = null;
    this.#pending = null;
    this.#selection = null;
    return this.#last = result('ready', '已更新目标，下一条指令将重新定位。');
  }

  clearClarification() {
    this.#pending = null;
  }

  stop() {
    this.#selection = null;
    this.#pending = null;
    if (!this.#active) return result('idle', '当前没有正在执行的操作。');
    const task = this.#active;
    task.controller.abort();
    if (task.phase === 'effect') {
      // An OS operation may already be in flight. Keep the writer slot until
      // the adapter reports its actual outcome, including an unknown result.
      return result('stopping', '已停止后续步骤，正在核对已经发起的动作。');
    }
    this.#active = null;
    return this.#last = result('stopped', '已停止，本次待执行的动作已取消。');
  }

  // Called at speech onset, before transcription of the final utterance.
  // Explicitly unavailable bindings stay unavailable throughout this turn.
  async captureAtStart({ signal = new AbortController().signal, foregroundHwnd } = {}) {
    const binding = await this.#snapshot(signal);
    if (!this.#target && foregroundHwnd != null && binding?.hwnd !== foregroundHwnd) return null;
    return binding;
  }

  handle(text, { id = randomUUID(), initialBinding, windowHandle } = {}) {
    if (this.#requests.has(id)) return this.#requests.get(id);
    if (typeof text !== 'string' || !text.trim()) return Promise.resolve(result('invalid', '请输入指令。'));
    if (/^(停一下|停止执行|取消这次|停止|算了|取消)[。！!？?]?$/u.test(text.trim())) {
      const reply = Promise.resolve(this.stop());
      this.#requests.set(id, reply);
      return reply;
    }
    if (this.#active) return Promise.resolve(result('busy', '当前指令尚在处理，可以说“停一下”。'));
    const task = { controller: new AbortController(), phase: 'planning' };
    this.#active = task;
    const reply = this.#run(text, task, initialBinding, windowHandle).catch(error => {
      if (task.controller.signal.aborted && task.phase !== 'effect') return result('stopped', '已停止。');
      return result('error', error?.message || '执行失败。');
    }).then(outcome => {
      if (this.#active === task) {
        this.#active = null;
        this.#last = outcome;
      }
      return outcome;
    });
    this.#requests.set(id, reply);
    return reply;
  }

  async #snapshot(signal) {
    const binding = await this.#capture(this.#target, { signal });
    signal.throwIfAborted();
    if (!binding) return null;
    if (!binding.identity || typeof binding.target !== 'string' || typeof binding.draft !== 'string') {
      throw new Error('无法确认目标输入框。');
    }
    return Object.freeze(structuredClone(binding));
  }

  async #run(text, task, initialBinding, windowHandle) {
    const signal = task.controller.signal;
    let start = initialBinding === undefined ? await this.#snapshot(signal) : initialBinding;
    const currentWeChat = Boolean(start?.recipient && start.isForeground && start.sendAvailable);
    const context = { target: start?.chatApp || start?.target || '', chatApp: start?.chatApp, currentWeChat,
      draft: start?.draft ? '当前输入框有草稿' : '' };
    const pending = this.#pending;
    if (pending) {
      const { original, question, answers, weChat } = pending;
      context.clarification = { original, question, answers, weChat };
    }
    const selection = this.#selection;
    this.#selection = null;
    const ordinal = selection && /^(?:我?选)?第?([一二两三四五六七八九十]|\d+)个?[。！？!?]?$/u.exec(text.trim());
    const index = ordinal ? (Number(ordinal[1]) || '一二三四五六七八九十'.indexOf(ordinal[1].replace('两','二')) + 1) - 1 : -1;
    if (ordinal && (index < 0 || index >= selection.options.length)) {
      this.#selection = selection;
      return result('clarify', selection.question);
    }
    const replyingWithWeChat = pending && /发|寄送/u.test(pending.original)
      && /^(?:在|用)?\s*(?:微信|wechat)(?:里|里面|上)?[。！？!?]?$/iu.test(text.trim());
    let decision = ordinal ? selection.decision : replyingWithWeChat && !currentWeChat
      ? { intent: 'clarify', value: '请打开要发送的微信聊天，或说出收件人。' }
      : await this.#decide(text, context, { signal });
    signal.throwIfAborted();
    if (decision.intent === 'clarify') {
      this.#pending = { original: pending?.original ?? text, question: decision.value,
        answers: pending ? [...pending.answers, text] : [], weChat: Boolean(replyingWithWeChat || pending?.weChat),
        chatIdentity: pending?.chatIdentity ?? (currentWeChat ? start.identity : null) };
      return result('clarify', decision.value);
    }
    this.#pending = null;
    if (pending?.chatIdentity && !decision.recipient && ['send_draft','fill_send'].includes(decision.intent)
        && start?.identity !== pending.chatIdentity) {
      return result('target_changed', '微信聊天已切换，请在要发送的聊天里重新说完整指令。');
    }
    if (['list_controls','focus_control','press_button'].includes(decision.intent)) {
      const hwnd = windowHandle === undefined ? start?.hwnd : windowHandle;
      if (!hwnd) return result('clarify', '请切到目标窗口，再说一次。');
      task.phase = 'effect';
      return this.#apply(decision, {hwnd}, {signal});
    }
    if (decision.recipient) {
      if (this.#locate) {
        let source = ordinal ? selection.source : start;
        if (decision.intent === 'send_draft' && !ordinal
            && (!source?.draft?.trim() || !sameDraft(source, await this.#snapshot(signal))
                || (this.#binding && !sameDraft(this.#binding, source)))) {
          return result('target_changed', '未能核对要转发的原草稿，请重新指定。');
        }
        if (decision.intent !== 'send_draft') source = null;
        task.phase = 'effect';
        const choice = ordinal ? { options: selection.options, hwnd: selection.hwnd, index } : null;
        const found = await this.#locate(decision.recipient, choice, signal);
        signal.throwIfAborted();
        if (found.status === 'choices') {
          const labels = found.options.map((item, i) => `${i + 1}. ${item.label}`).join('；');
          const question = `微信找到多个匹配项：${labels}。请按列表顺序回答，例如“选第二个”。`;
          this.#selection = { decision, source, originIdentity: start?.identity, options: found.options, hwnd: found.hwnd, question };
          return result('clarify', question);
        }
        const originIdentity = ordinal ? selection.originIdentity : start?.identity;
        start = found.binding;
        if ((decision.intent === 'fill_send' || source) && start?.draft && start.identity !== originIdentity) {
          return result('held', '切换到的聊天有另一段未发送的内容，请在该聊天中继续。');
        }
        if (source && start?.identity !== source.identity) {
          decision = { ...decision, intent: 'fill_send', value: source.draft };
        } else if (source && source.draft !== start.draft) {
          return result('target_changed', '原草稿已经变化，请重新指定。');
        }
      }
      if (decision.recipient !== start?.recipient) {
        return result('clarify', `请先切换到微信聊天「${decision.recipient}」，再重复指令。`);
      }
      start = { ...start, requiredRecipient: decision.recipient };
    }
    if (!decision.recipient && !currentWeChat && (pending?.weChat || replyingWithWeChat || start?.isWeChat)
        && ['send_draft','fill_send'].includes(decision.intent)) {
      return result('clarify', '请先打开要发送的微信聊天，再说一次。');
    }
    if (pending?.weChat && decision.intent === 'fill_text' && !start?.recipient) {
      return result('clarify', '请先切换到目标微信聊天，再重复发送指令。');
    }
    if (decision.intent === 'steam_search') {
      task.phase = 'effect';
      this.#binding = null;
      return this.#apply(decision, null, { signal });
    }
    if (decision.intent === 'hold') {
      if (!this.#binding && start) this.#binding = start;
      return result('held', '已保留当前内容。');
    }
    if (decision.intent === 'compare_budget') {
      const comparison = await this.#apply(decision, null, { signal });
      signal.throwIfAborted();
      return comparison;
    }
    if (decision.intent === 'open_app') {
      task.phase = 'effect';
      const opened = await this.#apply(decision, null, { signal });
      if (opened?.status !== 'opened') return result('unknown', '未确认窗口是否已打开。');
      this.#binding = null;
      return result('opened', opened.message || '已打开应用。');
    }
    if (!start) return result('clarify', '请指定可编辑的目标窗口和输入框。');
    // A follow-up may arrive after the user changed conversations or edited
    // the draft. Check both the previous turn and the time spent classifying.
    const previous = this.#binding;
    const clearedAfterSubmit = previous && previous.identity === start.identity
      && start.draft === '' && this.#sent.get(start.identity)?.draft === previous.draft;
    const usesExistingDraft = ['read_draft', 'replace_text', 'send_draft'].includes(decision.intent);
    const useVisibleDraft = currentWeChat && decision.currentChat && decision.intent === 'send_draft';
    if (usesExistingDraft && !useVisibleDraft && previous && !sameDraft(start, previous) && !clearedAfterSubmit) {
      return result('target_changed', '当前输入框或草稿和上次不同。要操作眼前的草稿，请单独说“使用当前窗口”后重试。');
    }
    if (!sameDraft(start, await this.#snapshot(signal))) {
      return result('target_changed', '未能核对录音开始时的输入框和内容。请回到目标输入框，再说一次。');
    }
    this.#binding = start;
    if (decision.intent === 'read_draft') return result('read', start.draft || '草稿为空。', { draft: start.draft });
    if (decision.intent === 'send_draft') return this.#send(start, task);
    let draft;
    if (decision.intent === 'replace_text') {
      const { from, to } = decision;
      if (typeof from !== 'string' || !from || typeof to !== 'string') {
        return result('clarify', '请说明要替换的原文和新内容。');
      }
      const index = start.draft.indexOf(from);
      if (index === -1 || start.draft.indexOf(from, index + 1) !== -1) {
        return result('clarify', '原文没有唯一匹配，请说出更长的一段原文。');
      }
      draft = start.draft.slice(0, index) + to + start.draft.slice(index + from.length);
    } else if (['dictate', 'fill_text', 'fill_send'].includes(decision.intent)) {
      const content = decision.intent === 'dictate' ? text : decision.value;
      if (typeof content !== 'string' || !content.trim()) return result('clarify', '请说明要写入的正文。');
      draft = start.draft + content;
    } else {
      return result('clarify', '这项操作暂不支持，请换一种指令。');
    }
    signal.throwIfAborted();
    task.phase = 'effect';
    const written = await this.#apply({ intent: 'set_draft', value: draft }, start, { signal });
    if (written?.status !== 'written' || written.draft !== draft) {
      return result('unknown', '写入结果未能核对，请查看当前草稿。');
    }
    const updated = Object.freeze({ ...start, draft });
    this.#binding = updated;
    // A verified new write supersedes the previous attempt for this target.
    if (draft !== start.draft) this.#sent.delete(start.identity);
    if (decision.intent === 'fill_send' && !signal.aborted) return this.#send(updated, task);
    return result('written', signal.aborted ? '已填写草稿，后续动作已停止。' : '已更新草稿。', { draft });
  }

  async #send(binding, task) {
    const signal = task.controller.signal;
    if (!binding.draft.trim()) return result('held', '当前没有可发送的草稿。');
    const prior = this.#sent.get(binding.identity);
    if (prior && prior.draft === binding.draft) {
      return result('already_attempted', '这条刚才已尝试发送，为防重复没有重发，请先确认结果。', { level: 'warning', previousStatus: prior.status });
    }
    signal.throwIfAborted();
    task.phase = 'effect';
    const record = { draft: binding.draft, status: 'unknown' };
    this.#sent.set(binding.identity, record);
    try {
      const outcome = await this.#apply({ intent: 'send_draft' }, binding, { signal });
      if (outcome?.status === 'confirmed' || outcome?.status === 'submitted') record.status = outcome.status;
      if (outcome?.status === record.status && outcome.message) {
        record.message = outcome.message;
        record.level = outcome.level;
      }
    } catch (error) {
      if (error?.beforeCommit) {
        this.#sent.delete(binding.identity);
        throw error;
      }
    }
    this.#binding = binding;
    if (record.message) return result(record.status, record.message, { level: record.level });
    if (record.status === 'confirmed') return result('confirmed', '已发送。', { level: 'success' });
    if (record.status === 'submitted') return result('submitted', '已点击发送，无法确认是否发出，请查看窗口。', { level: 'warning' });
    return result('unknown', '发送过程出错，结果未知，请先查看对话。', { level: 'error' });
  }
}
