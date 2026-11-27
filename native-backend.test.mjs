import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeProtocol } from './native-backend.mjs';
import { Session } from './session.mjs';

function fixture(capture = async ({ foregroundHwnd }) => ({ identity: 'a', hwnd: foregroundHwnd })) {
  const calls = [], replies = [];
  const wire = nativeProtocol(reply => replies.push(reply), () => ({
    captureAtStart: capture,
    async handle(text, args) {
      calls.push({ text, ...args });
      return { status: 'held', message: '已保留当前内容。' };
    },
    stop() {},
    clearClarification() {},
    setTarget() { return { status: 'ready', message: '目标已更新。' }; },
  }));
  return { ...wire, calls, replies };
}

test('uses the recording-onset binding and dispatches one finish per turn', async () => {
  const backend = fixture();
  await backend.receive({ op: 'start', turn: 1, hwnd: 7 });
  const finish = { op: 'finish', turn: 1, text: '先别发', targetUnchanged: true, apiKey: 'test-only' };
  await backend.receive(finish);
  await backend.receive(finish);
  assert.deepEqual(backend.calls, [{ text: '先别发', id: '1', initialBinding: { identity: 'a', hwnd: 7 }, windowHandle: 7 }]);
  assert.deepEqual(backend.replies.map(r => r.status), ['held', 'stale']);
  assert.ok(!JSON.stringify(backend.replies).includes('test-only'));
});

test('changed native target never falls back to current foreground editor', async () => {
  const backend = fixture();
  await backend.receive({ op: 'start', turn: 1, hwnd: 7 });
  await backend.receive({ op: 'finish', turn: 1, text: '写入', targetUnchanged: false });
  assert.equal(backend.calls[0].initialBinding, null);
});

test('switching windows between recordings preserves the previous draft guard', async () => {
  const editor = { hwnd: 7, identity: 'A', target: '输入框', draft: '草稿' };
  const replies = [];
  const wire = nativeProtocol(reply => replies.push(reply), () => new Session({
    capture: async () => ({ ...editor }),
    decide: async text => ({ intent: text === '读一下' ? 'read_draft' : 'send_draft' }),
    apply: async () => assert.fail('must not send to the second window'),
  }));
  await wire.receive({ op: 'start', turn: 1, hwnd: 7 });
  await wire.receive({ op: 'finish', turn: 1, text: '读一下', targetUnchanged: true });
  Object.assign(editor, { hwnd: 8, identity: 'B' });
  await wire.receive({ op: 'start', turn: 2, hwnd: 8 });
  await wire.receive({ op: 'finish', turn: 2, text: '把刚才那段发出去', targetUnchanged: true });
  assert.deepEqual(replies.map(r => r.status), ['read', 'target_changed']);
});

test('stop while capture is pending discards late results; no replay after a newer start', async () => {
  let complete;
  const backend = fixture(() => new Promise(resolve => { complete = resolve; }));
  await backend.receive({ op: 'start', turn: 1, hwnd: 9 });
  const finish = { op: 'finish', turn: 1, text: '发送', targetUnchanged: true };
  const pending = backend.receive(finish);
  await backend.receive({ op: 'stop', turn: 1 });
  complete({ target: 'old' });
  await pending;
  await backend.receive({ op: 'start', turn: 2, hwnd: null });
  await backend.receive({ op: 'start', turn: 1, hwnd: 9 });
  await backend.receive(finish);
  assert.deepEqual(backend.calls, []);
  assert.equal(backend.replies.at(-1).status, 'stale');
});
