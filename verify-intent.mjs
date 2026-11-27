import assert from 'node:assert/strict';
import { classify, decode } from './intent.mjs';

const cases = [
  ['他说让我打开微信', {}, { intent: 'dictate', text: '他说让我打开微信' }],
  ['帮我打开微信', {}, { intent: 'open_app', value: '微信' }],
  ['我已经打开记事本了', {}, { intent: 'dictate', text: '我已经打开记事本了' }],
  ['在当前输入框写一句：我晚十分钟到', {}, { intent: 'fill_text', value: '我晚十分钟到' }],
  ['把这段发出去', { draft: '我晚十分钟到', target: '测试对话' }, { intent: 'send_draft' }],
  ['把这段发过去', {}, { intent: 'clarify' }],
];

assert.throws(() => decode('{"intent":"unknown","value":null}', '', {}));
assert.equal(decode('{"intent":"send_draft","value":null}', '', {}).intent, 'clarify');
for (const [text, context, expected] of cases) {
  const decision = await classify(text, context);
  console.log(text, JSON.stringify(decision));
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(decision[key], value, text);
  }
}
console.log(`通过 ${cases.length} 条真实 API 用例。`);
