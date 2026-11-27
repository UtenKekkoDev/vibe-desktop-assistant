import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from './session.mjs';
import { VoiceSession } from './voice-session.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ decide, capture, wakeWord, onState, closeMicrophone } = {}) {
  const editor = { identity: 'A', target: '会话', draft: '', hwnd: 101 };
  const requests = [];
  const writes = [];
  const session = new Session({
    capture: capture ?? (async () => ({ ...editor })),
    async decide(text, context, options) {
      requests.push(text);
      return decide ? await decide(text, context, options) : { intent: 'dictate' };
    },
    async apply(action, binding) {
      assert.equal(binding.identity, editor.identity);
      assert.equal(action.intent, 'set_draft');
      writes.push(action.value);
      editor.draft = action.value;
      return { status: 'written', draft: editor.draft };
    },
  });
  const voice = new VoiceSession({ session, wakeWord, onState, closeMicrophone });
  async function say(id, text) {
    voice.begin(id, { foregroundHwnd: editor.hwnd });
    return voice.finish(id, text);
  }
  return { voice, editor, requests, writes, say };
}

test('only an utterance beginning with the wake word leaves standby', async () => {
  const states = [];
  const { voice, requests, say, writes } = fixture({ onState: state => states.push(state) });
  assert.equal((await say('1', '他说小助手要写点什么')).status, 'ignored');
  assert.deepEqual(requests, []);
  assert.equal((await say('2', '小助手，')).status, 'awake');
  assert.deepEqual(requests, []);
  assert.equal(voice.state, 'listening');
  assert.equal((await say('3', '写下“休眠”两个字。')).status, 'written');
  assert.deepEqual(writes, ['写下“休眠”两个字。']);
  assert.equal((await say('4', '休眠。')).status, 'sleeping');
  assert.equal((await say('5', '这句不要发给模型')).status, 'ignored');
  assert.equal((await say('6', '小助手，继续。')).status, 'written');
  assert.deepEqual(requests, ['写下“休眠”两个字。', '继续。']);
  assert.deepEqual(states, ['listening', 'standby', 'listening']);
});

test('literal wake words are configurable and English words need a boundary', async () => {
  const { say, requests } = fixture({ wakeWord: 'Hey Vibe' });
  assert.equal((await say(1, 'Hey Vibes！')).status, 'ignored');
  assert.equal((await say(2, 'HEY VIBE, 写这句')).status, 'written');
  assert.deepEqual(requests, ['写这句']);
});

test('a duplicate, stale or missing audio event cannot execute an action', async () => {
  const { voice, requests } = fixture();
  voice.begin(1);
  voice.begin(2);
  assert.equal((await voice.finish(2, '小助手，正文')).status, 'written');
  assert.equal((await voice.finish(1, '小助手，旧句')).status, 'ignored');
  voice.begin(2);
  assert.equal((await voice.finish(2, '小助手，重复')).status, 'ignored');
  assert.equal((await voice.finish(3, '没有开口事件')).status, 'ignored');
  voice.begin(4);
  voice.discard(4);
  assert.equal((await voice.finish(4, '废弃片段')).status, 'ignored');
  assert.deepEqual(requests, ['正文']);
});

test('identity comes from speech onset even when the title and draft are unchanged', async () => {
  const { voice, editor, writes } = fixture();
  voice.begin(1, { foregroundHwnd: 101 });
  editor.identity = 'B';
  const outcome = await voice.finish(1, '小助手，填写到刚才的对话');
  assert.equal(outcome.status, 'target_changed');
  assert.deepEqual(writes, []);
});

test('a foreground change before the capture worker runs leaves the utterance unbound', async () => {
  const { voice, writes } = fixture();
  voice.begin(1, { foregroundHwnd: 999 });
  assert.equal((await voice.finish(1, '小助手，请输入正文')).status, 'clarify');
  assert.deepEqual(writes, []);
});

test('busy input is not queued, local stop cancels a late model response', async () => {
  const started = deferred();
  const late = deferred();
  const { voice, writes, requests, say } = fixture({
    decide: async text => {
      if (text === '慢指令') { started.resolve(); return late.promise; }
      return { intent: 'dictate' };
    },
  });
  const slow = say(1, '小助手，慢指令');
  await started.promise;
  assert.equal((await say(2, '另一条指令')).status, 'busy');
  assert.equal((await say(3, '停一下！')).status, 'stopped');
  assert.equal((await say(4, '新的正文')).status, 'written');
  late.resolve({ intent: 'fill_text', value: '旧结果' });
  assert.equal((await slow).status, 'stopped');
  assert.deepEqual(requests, ['慢指令', '新的正文']);
  assert.deepEqual(writes, ['新的正文']);
  assert.equal(voice.state, 'listening');
});

test('standby discards capture failures without a model call, and wake-only is still usable', async () => {
  const { say, requests } = fixture({ capture: async () => { throw new Error('本地绑定失败'); } });
  assert.equal((await say(1, '随便说话')).status, 'ignored');
  assert.equal((await say(2, '小助手')).status, 'awake');
  assert.equal((await say(3, '写正文')).status, 'error');
  assert.deepEqual(requests, []);
});

test('a spoken hold interrupts an earlier uncommitted send', async () => {
  const started = deferred(), late = deferred();
  const { say, writes } = fixture({ decide: async () => { started.resolve(); return late.promise; } });
  const original = say(1, '小助手，写一句然后发送');
  await started.promise;
  assert.equal((await say(2, '先别发。')).status, 'stopped');
  late.resolve({ intent: 'fill_send', value: '测试消息' });
  assert.equal((await original).status, 'stopped');
  assert.deepEqual(writes, []);
});

test('sleep and microphone off invalidate in-flight capture and close once', async () => {
  const blocked = deferred();
  let closeCount = 0;
  const { voice, say, requests } = fixture({
    capture: () => blocked.promise,
    closeMicrophone: () => { closeCount++; },
  });
  const pending = say(1, '小助手，慢指令');
  assert.equal((await say(2, '休眠')).status, 'sleeping');
  blocked.resolve(null);
  assert.equal((await pending).status, 'ignored');
  assert.equal((await say(3, '小助手，关麦。')).status, 'closed');
  assert.equal((await say(4, '小助手，重新开麦')).status, 'ignored');
  voice.close();
  assert.equal(closeCount, 1);
  assert.deepEqual(requests, []);
});
