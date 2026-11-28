import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from './session.mjs';
import { classify, decode } from './intent.mjs';
import { createAssistant } from './assistant.mjs';

test('foreground WeChat routes current-chat messages and draft sends without contact search', async () => {
  const editor = { identity:'wx/1', hwnd:7, target:'微信', recipient:'本地测试对象', isWeChat:true,
    isForeground:true, sendAvailable:true, draft:'' };
  const actions = [];
  const session = createAssistant({}, {
    decide: async (text, ctx) => {
      assert.equal(ctx.currentWeChat,true);
      assert.ok(!JSON.stringify(ctx).includes(editor.recipient));
      if (text === '发送') return classify(text,ctx);
      return decode(JSON.stringify({intent:'fill_send',value:'我到了',recipient:'当前聊天框'}),text,ctx);
    },
    desktop: async req => {
      if (req.op === 'capture') return {...editor};
      assert.equal(req.op,'apply');
      assert.equal(req.binding.identity,editor.identity);
      actions.push(req.decision.intent);
      if (req.decision.intent === 'set_draft') {
        editor.draft = req.decision.value;
        return {status:'written',draft:editor.draft};
      }
      assert.equal(req.decision.intent,'send_draft');
      editor.draft = '';
      return {status:'confirmed'};
    },
  });
  const start = await session.captureAtStart({foregroundHwnd:7});
  assert.equal((await session.handle('给当前聊天框发一句我到了',{initialBinding:start})).status,'confirmed');
  Object.assign(editor,{identity:'wx/2',draft:'第二个聊天的草稿'});
  assert.equal((await session.handle('发送')).status,'confirmed');
  assert.equal((await session.handle('发送')).status,'clarify');
  session.clearClarification();
  editor.draft = '待发';
  const old = await session.captureAtStart({foregroundHwnd:7});
  editor.identity = 'wx/3';
  assert.equal((await session.handle('发送',{initialBinding:old})).status,'target_changed');
  assert.deepEqual(actions,['set_draft','send_draft','send_draft']);
});

test('a missing WeChat conversation never redirects a send to another editor', async () => {
  const response = JSON.stringify({intent:'fill_send',value:'我到了',recipient:null,application:'微信'});
  assert.equal(decode(response,'在微信里发一句我到了',{target:'记事本'}).intent,'clarify');
  const {session,editor,writes,count} = fixture();
  Object.assign(editor,{isWeChat:true,isForeground:true,sendAvailable:false});
  assert.equal((await session.handle('边写边发')).status,'clarify');
  assert.deepEqual(writes,[]);
  assert.equal(count(),0);
});

test('a WeChat clarification cannot move an unnamed message into a different chat', async () => {
  const {session,editor,writes,count} = fixture({
    decide: async (text,ctx) => ctx.clarification ? {intent:'fill_send',value:'我到了'}
      : {intent:'clarify',value:'你想在哪里发送？'},
  });
  Object.assign(editor,{isWeChat:true,isForeground:true,sendAvailable:true,recipient:'甲'});
  assert.equal((await session.handle('帮我发我到了')).status,'clarify');
  Object.assign(editor,{identity:'另一个聊天',recipient:'乙'});
  assert.equal((await session.handle('在微信')).status,'target_changed');
  assert.equal(count(),0);
  assert.deepEqual(writes,[]);
});

test('current AI questions submit, draft requests stay drafts, and a missing AI target asks', async () => {
  const ctx = {sessionMode:true,chatApp:'Codex'};
  assert.deepEqual(await classify('帮我问一下，这段代码为什么报错？',ctx),
    {intent:'fill_send',value:'这段代码为什么报错？'});
  assert.equal(decode('{"intent":"ask_ai","value":"检查代码"}','先写个提示词，别发',ctx).intent,'fill_text');
  assert.equal((await classify('帮我问一下，这段代码为什么报错？',{sessionMode:true})).intent,'clarify');
  assert.equal((await classify('去 Codex 的另外一个项目，检查代码',ctx)).intent,'clarify');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('generic controls use the onset window even without an editor and never retarget a changed window', async () => {
  const actions = [];
  const session = new Session({
    capture: async () => null,
    decide: async () => ({intent:'press_button', value:'刷新'}),
    apply: async (decision, binding) => { actions.push(binding.hwnd); return {status:'submitted'}; },
  });
  assert.equal((await session.handle('点击刷新', {windowHandle:20,initialBinding:null})).status,'submitted');
  assert.equal((await session.handle('点击刷新', {windowHandle:null,initialBinding:null})).status,'clarify');
  assert.deepEqual(actions,[20]);
});

test('named sends must match the chat before either write or submit', async () => {
  const effects = [];
  const { session, editor } = fixture({
    decide: async text => decode('{"intent":"fill_send","value":"我到了","recipient":"小陈"}', text, {}),
    apply: async (action, binding) => {
      effects.push([action.intent, binding.requiredRecipient]);
      if (action.intent === 'set_draft') return { status: 'written', draft: action.value };
      return { status: 'submitted' };
    },
  });
  const text = '给小陈发一句我到了';
  editor.recipient = '小李';
  assert.equal((await session.handle(text)).status, 'clarify');
  assert.deepEqual(effects, []);
  editor.recipient = '小陈';
  assert.equal((await session.handle(text)).status, 'submitted');
  assert.deepEqual(effects, [['set_draft','小陈'], ['send_draft','小陈']]);
  for (const recipient of [undefined, null, '小李']) {
    assert.equal(decode(JSON.stringify({intent:'fill_send',value:'我到了',recipient}), text, {}).intent, 'clarify');
  }
});

test('WeChat answers a pending send question and survives into the next classification', async () => {
  const calls = [];
  const session = new Session({
    capture: async () => null,
    decide: async (text, context) => {
      calls.push(context);
      return {intent:'clarify', value:'要发什么？'};
    },
    apply: async () => assert.fail('no desktop action expected'),
  });
  await session.handle('把这段发过去');
  const next = await session.handle('微信。');
  assert.equal(next.status, 'clarify');
  assert.equal(calls.length, 1);
  await session.handle('发给小陈');
  assert.deepEqual(calls[1].clarification.answers, ['微信。']);
  assert.equal(calls[1].clarification.original, '把这段发过去');
});

function fixture(options = {}) {
  const editor = { target: '同一标题', identity: '项目/A/输入框', draft: '' };
  const writes = [];
  let sends = 0;
  const session = new Session({
    capture: async () => ({ ...editor }),
    decide: async text => ({
      写: { intent: 'fill_text', value: '周五交付' },
      改: { intent: 'replace_text', from: '周五', to: '周四' },
      读: { intent: 'read_draft' },
      留: { intent: 'hold' },
      发: { intent: 'send_draft' },
      边写边发: { intent: 'fill_send', value: '一条消息' },
    }[text] ?? { intent: 'dictate', text }),
    apply: async (action, binding) => {
      assert.equal(editor.identity, binding.identity);
      assert.equal(editor.draft, binding.draft);
      if (action.intent === 'set_draft') {
        writes.push(action.value);
        editor.draft = action.value;
        return { status: 'written', draft: editor.draft };
      }
      assert.equal(action.intent, 'send_draft');
      sends++;
      return { status: 'submitted' };
    },
    ...options,
  });
  return { session, editor, writes, count: () => sends };
}

test('choose a duplicate and finish the original send without classifying the number', async () => {
  const options = [{id:[1],label:'联系人 · 小陈'}, {id:[2],label:'群聊 · 小陈'}];
  let planned = 0;
  const {session, editor, count} = fixture({
    decide: async () => { planned++; return {intent:'fill_send',recipient:'小陈',value:'晚十分钟到'}; },
    locate: async (name, choice) => {
      if (!choice) return {status:'choices',options,hwnd:88};
      assert.deepEqual(choice,{options,hwnd:88,index:1});
      Object.assign(editor,{identity:'B',recipient:name});
      return {status:'located',binding:{...editor}};
    },
  });
  assert.equal((await session.handle('帮我跟小陈说，晚十分钟到')).status,'clarify');
  assert.equal(count(),0);
  assert.equal((await session.handle('选第二个。')).status,'submitted');
  assert.equal(planned,1);
  assert.equal(count(),1);
  assert.equal(editor.draft,'晚十分钟到');
});

test('append to the current draft and submit it once without clarification', async () => {
  const {session,editor,count,writes} = fixture();
  editor.draft = '已有正文。';
  assert.equal((await session.handle('边写边发')).status, 'submitted');
  assert.deepEqual(writes, ['已有正文。一条消息']);
  assert.equal(count(), 1);
});

test('forward the source draft instead of sending an unrelated destination draft', async () => {
  const {session,editor,count,writes} = fixture({
    decide:async () => ({intent:'send_draft',recipient:'小陈'}),
    locate:async name => {
      Object.assign(editor,{identity:'B',recipient:name,draft:'已有其他内容'});
      return {status:'located',binding:{...editor}};
    },
  });
  editor.draft='原草稿';
  assert.equal((await session.handle('把这段发给小陈')).status,'held');
  assert.equal(count(),0);
  assert.deepEqual(writes,[]);
});

test('write, replace, locally read, hold and submit using one binding', async () => {
  const { session, editor, count } = fixture();
  assert.equal((await session.handle('写')).status, 'written');
  assert.equal((await session.handle('改')).status, 'written');
  assert.equal((await session.handle('读')).message, '周四交付');
  assert.equal((await session.handle('留')).status, 'held');
  assert.equal(editor.draft, '周四交付');
  assert.equal(count(), 0);
  const [a, b] = await Promise.all([session.handle('发', { id: '1' }), session.handle('发', { id: '1' })]);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'submitted');
  assert.equal((await session.handle('发')).status, 'already_attempted');
  assert.equal(count(), 1);
});

test('identical title and draft in another conversation do not permit sending', async () => {
  const { session, editor, count } = fixture();
  await session.handle('写');
  editor.identity = '项目/B/输入框';
  assert.equal((await session.handle('发')).status, 'target_changed');
  assert.equal(count(), 0);
});

for (const [text, expected, sends] of [
  ['明天下午三点见', '明天下午三点见', 0],
  ['写', '周五交付', 0],
  ['边写边发', '一条消息', 1],
]) {
  test(`fresh input follows the new editor: ${text}`, async () => {
    const { session, editor, count } = fixture();
    await session.handle('写');
    editor.identity = '项目/B/输入框';
    editor.draft = '';
    await session.handle(text);
    assert.equal(editor.draft, expected);
    assert.equal(count(), sends);
  });
}

test('changing the draft while classifying prevents overwriting it', async () => {
  const started = deferred();
  const response = deferred();
  const { session, editor, writes } = fixture({
    decide: async () => { started.resolve(); return response.promise; },
  });
  const pending = session.handle('写');
  await started.promise;
  editor.draft = '用户新内容';
  response.resolve({ intent: 'fill_text', value: '晚到的结果' });
  assert.equal((await pending).status, 'target_changed');
  assert.deepEqual(writes, []);
});

test('stopping an uncooperative classifier frees the session and fences off late results', async () => {
  const started = deferred();
  const late = deferred();
  const { session, writes } = fixture({
    decide: async text => {
      if (text === '慢') { started.resolve(); return late.promise; }
      return { intent: 'fill_text', value: '新草稿' };
    },
  });
  const pending = session.handle('慢');
  await started.promise;
  assert.equal(session.stop().status, 'stopped');
  assert.equal((await session.handle('快')).status, 'written');
  late.resolve({ intent: 'fill_send', value: '旧内容' });
  assert.equal((await pending).status, 'stopped');
  assert.deepEqual(writes, ['新草稿']);
  assert.equal(session.status().status, 'written');
});

test('a stop during fill-and-send preserves a verified write and skips submit', async () => {
  const started = deferred();
  const resume = deferred();
  const { session } = fixture({
    apply: async action => {
      assert.equal(action.intent, 'set_draft');
      started.resolve();
      await resume.promise;
      return { status: 'written', draft: action.value };
    },
  });
  const pending = session.handle('边写边发');
  await started.promise;
  assert.equal(session.stop().status, 'stopping');
  resume.resolve();
  assert.equal((await pending).status, 'written');
});

test('ambiguous submit locks out retries even with a new request id', async () => {
  let calls = 0;
  const { session, editor } = fixture({ apply: async () => { calls++; throw new Error('connection lost'); } });
  editor.draft = '消息';
  assert.deepEqual(await session.handle('发', { id: '1' }), {
    status: 'unknown', level: 'error', message: '发送过程出错，结果未知，请先查看对话。',
  });
  assert.deepEqual(await session.handle('发', { id: '2' }), {
    status: 'already_attempted', level: 'warning', previousStatus: 'unknown',
    message: '这条刚才已尝试发送，为防重复没有重发，请先确认结果。',
  });
  assert.equal(calls, 1);
});

test('stopping after submit dispatch reports the eventual result without retry', async () => {
  const started = deferred();
  const receipt = deferred();
  const { session, editor } = fixture({ apply: async () => { started.resolve(); return receipt.promise; } });
  editor.draft = '消息';
  const pending = session.handle('发');
  await started.promise;
  assert.equal(session.stop().status, 'stopping');
  receipt.resolve({ status: 'confirmed' });
  assert.equal((await pending).status, 'confirmed');
  assert.equal((await session.handle('发')).status, 'already_attempted');
});

test('literal quotes and repeated substrings are preserved', async () => {
  const { session, editor, count } = fixture();
  await session.handle('正文里有“发出去”，周五和周五。');
  assert.equal((await session.handle('改')).status, 'clarify');
  assert.equal(editor.draft, '正文里有“发出去”，周五和周五。');
  assert.equal(count(), 0);
});

test('a budget decision can run without an editor or desktop mutation', async () => {
  const { session } = fixture({
    capture: async () => null,
    decide: async () => ({ intent: 'compare_budget', category: '人工' }),
    apply: async (decision, binding) => {
      assert.equal(binding, null);
      assert.equal(decision.category, '人工');
      return { status: 'compared', message: '已比较' };
    },
  });
  assert.equal((await session.handle('只比较人工预算')).status, 'compared');
});
