import { createInterface } from 'node:readline';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { createAssistant } from './assistant.mjs';
import { classify } from './intent.mjs';

const resetTarget = /^(使用当前窗口|重新绑定当前窗口)[。！？!?]?$/u;

// Each recording owns its onset snapshot, cancellation signal and credentials.
export function nativeProtocol(send, makeSession = createAssistant) {
  const keys = new AsyncLocalStorage();
  const session = makeSession({}, {
    decide: (text, context, options) => classify(text, context, { ...options, apiKey: keys.getStore()?.apiKey }),
    onProgress: stage => {
      const request = keys.getStore();
      if (request?.wantProgress && current?.id === request.turn && !current.controller.signal.aborted)
        send({ turn: request.turn, status: 'progress', stage });
    },
  });
  let current = null;
  let lastId = 0;

  function stop(turn) {
    turn.controller.abort();
    if (turn.running) session.stop();
  }

  async function receive(request) {
    const id = request.turn;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (request.op === 'start') {
      if (id <= lastId) return;
      lastId = id;
      if (current) {
        stop(current);
        if (current.hwnd !== request.hwnd) session.clearClarification();
      }
      const controller = new AbortController();
      const capture = request.hwnd == null ? Promise.resolve(null) :
        session.captureAtStart({ foregroundHwnd: request.hwnd, signal: controller.signal }).catch(() => null);
      current = { id, hwnd: request.hwnd, capture, controller, running: false, consumed: false };
      return;
    }
    const turn = current;
    if (request.op === 'stop') {
      if (turn?.id === id) stop(turn);
      return;
    }
    if (request.op !== 'finish') return;
    if (turn?.id !== id || turn.consumed || turn.controller.signal.aborted) {
      send({ turn: id, status: 'stale', message: '这次录音已结束，未重新执行。' });
      return;
    }
    turn.consumed = true;
    try {
      const binding = await turn.capture;
      turn.controller.signal.throwIfAborted();
      if (typeof request.text !== 'string' || !request.text.trim()) throw new Error();
      const utterance = request.text.trim();
      turn.running = true;
      const result = resetTarget.test(utterance)
        ? session.setTarget(null)
        : await keys.run(request, () => session.handle(utterance, {
          id: String(id), initialBinding: request.targetUnchanged ? binding : null,
          windowHandle: request.targetUnchanged ? turn.hwnd : null,
        }));
      send({ turn: id, status: result.status, message: result.message, level: result.level });
    } catch {
      send({ turn: id, status: 'error', message: turn.controller.signal.aborted
        ? '操作已停止。' : '桌面助手未能处理这次指令。' });
    } finally {
      turn.running = false;
    }
  }
  return { receive, close() { if (current) stop(current); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const protocol = nativeProtocol(reply => process.stdout.write(JSON.stringify(reply) + '\n'));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      void protocol.receive(JSON.parse(line)).catch(() => { process.exitCode = 1; });
    } catch {
      process.exitCode = 1;
    }
  });
  lines.on('close', () => protocol.close());
}
