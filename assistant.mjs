import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { classify } from './intent.mjs';
import { compareBudgets } from './budget.mjs';
import { Session } from './session.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function bridge(request, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const search = request.decision?.intent === 'steam_search';
    const process = spawn(path.join(root, '.runtime', search ? 'ufo-env' : 'venv', 'Scripts/python.exe'),
      ['-X', 'utf8', path.join(root, search ? 'steam_search.py' : 'desktop_bridge.py')], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      });
    let out = '';
    if (search) {
      const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.stage === 'action' || event.stage === 'submitted') onProgress?.(event.stage);
          else if (typeof event.status === 'string' && typeof event.message === 'string') out = line;
        } catch { reject(new Error('无法读取 Steam 操作回执。')); }
      });
    } else {
      process.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    }
    process.stderr.resume();
    process.once('error', error => reject(search && error.code === 'ENOENT'
      ? new Error('请先运行 setup-ufo.ps1 准备 Steam 桌面组件。') : error));
    process.stdin.on('error', reject);
    process.once('close', code => {
      if (code !== 0) return reject(new Error('桌面工具运行中断，请核对目标窗口后重试。'));
      try {
        const receipt = JSON.parse(out);
        if (receipt?.status === 'error') reject(new Error(receipt.message));
        else resolve(receipt);
      } catch { reject(new Error('桌面返回了无法识别的结果。')); }
    });
    process.stdin.end(JSON.stringify(request));
  });
}

function budgetMessage(report) {
  const scope = report.category ? `分类「${report.category}」` : '全部分类';
  if (!report.rows.length) return `${scope}匹配 ${report.matchedCount} 个项目，没有可列出的金额变化。`;
  return [`${scope}匹配 ${report.matchedCount} 个项目，按差额绝对值排序：`,
    ...report.rows.map((row, i) => `${i + 1}. ${row.project}：${row.before.amount} → ${row.after.amount}（${row.difference}）\n   ${row.before.file} 第 ${row.before.line} 行；${row.after.file} 第 ${row.after.line} 行`),
  ].join('\n');
}

export function createAssistant(options, { decide = classify, desktop = bridge, onProgress } = {}) {
  const budgetsAvailable = Boolean(options.before && options.after);
  if (Boolean(options.before) !== Boolean(options.after)) throw new Error('预算比较需要同时指定 --before 和 --after。');
  let budgetCategory = null;
  let budgetCompared = false;
  const session = new Session({
    target: options.target ?? null,
    locate: (name, choice, signal) => desktop({ op: 'locate', name, choice }, signal),
    capture(target, { signal } = {}) {
      if (!target && budgetsAvailable) return null;
      return desktop({ op: 'capture', target, field: options.field, sendButton: options['send-button'] }, signal);
    },
    decide(text, ctx, { signal }) {
      // 只发送是否有草稿；引用片段按原指令提取，草稿全文留在本机。
      return decide(text, { target: ctx.target, chatApp: ctx.chatApp, currentWeChat: ctx.currentWeChat,
        draft: ctx.draft ? '已有草稿' : '', clarification: ctx.clarification,
        sessionMode: true, budgetsAvailable, budgetCompared, budgetCategory }, { signal });
    },
    async apply(decision, binding, { signal }) {
      if (decision.intent === 'steam_search') {
        signal.throwIfAborted();
        return desktop({ op: 'apply', decision }, signal, onProgress);
      }
      if (decision.intent !== 'compare_budget') {
        signal.throwIfAborted();
        // A dispatched OS action can have effects even if the user now stops.
        // Keep listening for its receipt; Session gates any subsequent action.
        const reply = await desktop({ op: 'apply', decision, binding });
        if (reply?.status === 'blocked') {
          const error = new Error(reply.message);
          error.beforeCommit = true;
          throw error;
        }
        return reply;
      }
      if (!budgetsAvailable) throw new Error('请先指定两份本地预算。');
      const report = await compareBudgets(options.before, options.after, { category: decision.category ?? undefined });
      signal?.throwIfAborted();
      budgetCompared = true;
      budgetCategory = report.category;
      return { status: 'compared', message: budgetMessage(report), report };
    },
  });
  return session;
}

const help = `在新行输入一句中文，回车执行。
:status 查看状态    :stop 停止当前操作    :target 完整标题 切换目标    :quit 退出
node assistant.mjs --target "窗口完整标题" [--field "输入框名称"]
node assistant.mjs --before "旧预算.csv" --after "新预算.csv"`;

export async function runTerminal(session, input = process.stdin, print = console.log) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  let generation = 0;
  print(help);
  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (text === ':quit') break;
    if (text === ':stop' || /^(停一下|停止|停止执行|取消这次)[。！？!?]?$/u.test(text)) {
      generation++;
      print(session.stop().message);
      chain = Promise.resolve();
      continue;
    }
    if (text === ':status') { const state = session.status(); print(state.message ?? JSON.stringify(state)); continue; }
    const turn = generation;
    chain = chain.then(async () => {
      if (turn !== generation) return;
      if (text.startsWith(':target ')) {
        const result = session.setTarget(text.slice(8).trim());
        print(result?.message ?? '已更新目标窗口。');
      } else if (text.startsWith(':')) print(help);
      else {
        const result = await session.handle(text);
        if (turn === generation || ['submitted', 'confirmed', 'unknown', 'written'].includes(result.status)) print(result.message);
      }
    }).catch(error => { if (turn === generation) print(error.message); });
  }
  await chain;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      target: { type: 'string' }, field: { type: 'string' }, 'send-button': { type: 'string' },
      before: { type: 'string' }, after: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log(help);
    else await runTerminal(createAssistant(values));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
