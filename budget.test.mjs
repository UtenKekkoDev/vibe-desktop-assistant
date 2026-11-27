import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareBudgets } from './budget.mjs';

async function fixture(t, before, after) {
  const folder = await mkdtemp(join(tmpdir(), 'vibe-budget-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const first = join(folder, '本期-前.csv');
  const second = join(folder, '随机名字-后.csv');
  await Promise.all([writeFile(first, before), writeFile(second, after)]);
  return [first, second];
}

test('compares exact cents by project and preserves source files and physical row numbers', async t => {
  const before = [
    '\uFEFF项目名称,类别,预算金额', '"设,计",人工成本,"1,200.10"', '',
    '服务器,设备,100', '"含""引号""\r\n的项目",人工成本,10.01',
    '无变化,人工成本,0', '支持,人工成本,9007199254740993.99', '小额,设备,1',
  ].join('\r\n');
  const after = [
    '金额,分类,项目', '21,设备,服务器', '0.00,人工成本,无变化',
    '20,人工成本,"含""引号""\n的项目"', '9007199254740994.00,人工成本,支持',
    '1300.10,人工成本,"设,计"', '0,设备,小额',
  ].join('\n');
  const [first, second] = await fixture(t, before, after);
  const all = await compareBudgets(first, second);
  assert.equal(all.matchedCount, 6);
  assert.deepEqual(all.rows.map(row => [row.project, row.difference]), [
    ['设,计', '+100.00'], ['服务器', '-79.00'], ['含"引号"\n的项目', '+9.99'],
  ]);
  assert.deepEqual(all.rows[2].before, { file: first, line: 5, amount: '10.01' });
  assert.deepEqual(all.rows[2].after, { file: second, line: 4, amount: '20.00' });
  const narrowed = await compareBudgets(first, second, { category: '人工成本' });
  assert.equal(narrowed.matchedCount, 4);
  assert.equal(narrowed.rows[2].difference, '+0.01');
  assert.equal(narrowed.rows[2].before.amount, '9007199254740993.99');
  assert.deepEqual(await compareBudgets(first, second, { category: '其他' }),
    { category: '其他', matchedCount: 0, limit: 3, rows: [] });
  assert.equal(await readFile(first, 'utf8'), before);
  assert.equal(await readFile(second, 'utf8'), after);
});

test('validates empty, duplicate, missing, conflicting and malformed records', async t => {
  const good = '项目,类别,金额\n甲,人工成本,1.00';
  const [first, second] = await fixture(t, good, good);
  const invalidCases = [
    ['', /空文件/],
    ['分类,金额\n工时,1', /缺少“项目”/],
    ['项目,金额,预算金额\n甲,1,1', /多个“金额”/],
    [good + '\n甲,人工成本,2', /第 3 行.*第 2 行重复/],
    [good.replace('甲', '乙'), /项目“甲”.*缺失/],
    [good.replace('人工成本', '设备'), /分类不一致/],
    [good.replace('1.00', '1.999'), /第 2 行.*金额无效/],
    [good.replace('1.00', '"1,0"'), /金额无效/],
    [good.replace('甲,', ','), /缺少项目名称/],
    [good.replace('人工成本', ''), /没有填写分类/],
    [good + ',尾', /列数与表头不一致/],
    [good + '\n"坏', /第 3 行.*未闭合/],
    [good + '\n"甲"x,工,2', /闭合引号后/],
    [Buffer.from([255]), /UTF-8 CSV/],
  ];
  for (const [content, expected] of invalidCases) {
    await writeFile(second, content);
    await assert.rejects(compareBudgets(first, second), expected);
  }
  await assert.rejects(compareBudgets(first, second + '.missing'), /无法读取预算文件/);
});

test('accepts uncategorized sheets, negative budgets and sorted ties', async t => {
  const [first, second] = await fixture(t,
    '项目,金额\nA,-10\nB,1\nC,5', '金额,项目\n+5,C\n0,B\n-9,A');
  const ranking = await compareBudgets(first, second);
  assert.deepEqual(ranking.rows.map(r => [r.project, r.difference]), [['A', '+1.00'], ['B', '-1.00']]);
  assert.equal((await compareBudgets(first, second, { limit: 1 })).rows.length, 1);
  await assert.rejects(compareBudgets(first, second, { category: '人工成本' }), /缺少“分类”/);
  await assert.rejects(compareBudgets(first, second, { category: '' }), /分类名称/);
  await assert.rejects(compareBudgets(first, second, { limit: 0 }), /正整数/);
});
