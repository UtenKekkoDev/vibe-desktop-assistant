import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Retain physical line numbers, including blank lines and newlines in quoted fields.
function csvRecords(content, file) {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const records = [];
  let fields = [];
  let value = '';
  let state = 'plain';
  let line = 1;
  let start = 1;

  function finishRecord() {
    fields.push(value.trim());
    if (fields.length > 1 || fields[0]) records.push({ fields, line: start });
    fields = [];
    value = '';
    state = 'plain';
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          state = 'closed';
        }
      } else {
        value += ch;
        if (ch === '\n') line++;
      }
    } else if (ch === '\n') {
      finishRecord();
      start = ++line;
    } else if (ch === ',') {
      fields.push(value.trim());
      value = '';
      state = 'plain';
    } else if (state === 'closed') {
      if (!/[ \t]/.test(ch)) throw new Error(`${file} 第 ${line} 行的闭合引号后有多余字符。`);
    } else if (ch === '"') {
      if (value.length) throw new Error(`${file} 第 ${line} 行的引号应位于字段开头。`);
      state = 'quoted';
    } else {
      value += ch;
    }
  }
  if (state === 'quoted') throw new Error(`${file} 第 ${start} 行的引号未闭合。`);
  finishRecord();
  return records;
}

function column(header, aliases, file, required = true) {
  const indices = header.fields.flatMap((name, index) => aliases.includes(name) ? [index] : []);
  if (indices.length > 1) throw new Error(`${file} 第 ${header.line} 行有多个“${aliases[0]}”列。`);
  if (!indices.length && required) throw new Error(`${file} 缺少“${aliases[0]}”列。`);
  return indices[0];
}

function parseCents(raw, location) {
  // Permit grouped thousands only when groups are correctly placed.
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(`${location} 的金额无效。请填写数字，最多保留两位小数。`);
  }
  const digits = raw.replace(/^[+-]|,/g, '');
  const [whole, fraction = ''] = digits.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return raw.startsWith('-') ? -cents : cents;
}

function decimal(cents, signed = false) {
  const magnitude = cents < 0n ? -cents : cents;
  const sign = cents < 0n ? '-' : signed && cents > 0n ? '+' : '';
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
}

async function loadBudget(path, categoryRequired) {
  const file = resolve(path);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (cause) {
    throw new Error(`无法读取预算文件 ${file}（${cause.code}）。`, { cause });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${file} 需保存为 UTF-8 CSV。`, { cause });
  }
  const [header, ...records] = csvRecords(text, file);
  if (!header) throw new Error(`${file} 是空文件。`);
  const projectCol = column(header, ['项目', '项目名称', '预算项目'], file);
  const categoryCol = column(header, ['分类', '类别', '费用类别'], file, categoryRequired);
  const amountCol = column(header, ['金额', '预算金额', '预算'], file);
  const projects = new Map();
  for (const { fields, line } of records) {
    const location = `${file} 第 ${line} 行`;
    if (fields.length !== header.fields.length) throw new Error(`${location} 的列数与表头不一致。`);
    const project = fields[projectCol];
    if (!project) throw new Error(`${location} 缺少项目名称。`);
    if (projects.has(project)) {
      throw new Error(`${location} 的项目“${project}”和第 ${projects.get(project).line} 行重复。`);
    }
    const category = fields[categoryCol] ?? null;
    if (category === '') throw new Error(`${location} 的项目“${project}”没有填写分类。`);
    projects.set(project, { line, category, cents: parseCents(fields[amountCol], location) });
  }
  return { file, projects };
}

/** Return the largest nonzero after-minus-before differences, with exact decimal amounts. */
export async function compareBudgets(beforePath, afterPath, { category = null, limit = 3 } = {}) {
  if (![beforePath, afterPath].every(path => typeof path === 'string' && path.trim())) {
    throw new Error('请指定两份本地预算 CSV 文件。');
  }
  if (category !== null && (typeof category !== 'string' || !category.trim())) {
    throw new Error('请指定有效的分类名称，或省略分类。');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('比较项数必须是正整数。');
  const filter = category?.trim() ?? null;
  const [before, after] = await Promise.all(
    [beforePath, afterPath].map(path => loadBudget(path, filter !== null)),
  );
  const changes = [];
  let matchedCount = 0;
  const projects = new Set([...before.projects.keys(), ...after.projects.keys()]);
  for (const project of projects) {
    const previous = before.projects.get(project);
    const current = after.projects.get(project);
    if (filter && previous?.category !== filter && current?.category !== filter) continue;
    if (!previous || !current) {
      const [present, entry, missing] = previous ? [before, previous, after] : [after, current, before];
      throw new Error(`${present.file} 第 ${entry.line} 行的项目“${project}”在 ${missing.file} 缺失，请核对两期数据。`);
    }
    if (previous.category && current.category && previous.category !== current.category) {
      throw new Error(`项目“${project}”的分类不一致：${before.file} 第 ${previous.line} 行为“${previous.category}”，${after.file} 第 ${current.line} 行为“${current.category}”。`);
    }
    matchedCount++;
    const change = current.cents - previous.cents;
    if (change !== 0n) changes.push({ project, previous, current, change, magnitude: change < 0n ? -change : change });
  }
  changes.sort((a, b) => {
    if (a.magnitude !== b.magnitude) return a.magnitude > b.magnitude ? -1 : 1;
    return a.project.localeCompare(b.project, 'zh-CN') ||
      Number(a.project > b.project) - Number(a.project < b.project);
  });
  const rows = changes.slice(0, limit).map(({ project, previous, current, change }) => ({
    project,
    category: current.category ?? previous.category,
    before: { file: before.file, line: previous.line, amount: decimal(previous.cents) },
    after: { file: after.file, line: current.line, amount: decimal(current.cents) },
    difference: decimal(change, true),
  }));
  return { category: filter, limit, matchedCount, rows };
}
