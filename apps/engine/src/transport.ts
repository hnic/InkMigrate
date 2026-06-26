/**
 * JSON-RPC over stdio 传输层。
 *
 * - stdin：按行读取 JSON-RPC Request
 * - stdout：输出 JSON-RPC Response 和 Notification（每行一个 JSON）
 * - stderr：日志输出（不干扰 JSON-RPC 通道）
 */
import * as readline from 'node:readline';
import type { RpcRequest, RpcResponse, RpcNotification, RpcError } from './protocol.js';

type RequestHandler = (
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

const handlers = new Map<string, RequestHandler>();

/** 注册一个 RPC method 处理器。 */
export function registerMethod(method: string, handler: RequestHandler): void {
  handlers.set(method, handler);
}

/** 发送 Response 到 stdout。 */
export function sendResponse(
  id: string | number,
  result: unknown,
): void {
  const msg: RpcResponse = { jsonrpc: '2.0', id, result };
  writeLine(msg);
}

/** 发送 Error Response 到 stdout。 */
export function sendErrorResponse(
  id: string | number,
  error: RpcError,
): void {
  const msg: RpcResponse = { jsonrpc: '2.0', id, error };
  writeLine(msg);
}

/** 发送 Notification 到 stdout（用于进度/日志推送）。 */
export function sendNotification(
  method: string,
  params?: Record<string, unknown>,
): void {
  const msg: RpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  writeLine(msg);
}

/** 发送日志到 stderr（不干扰 stdout JSON 通道）。 */
export function logToStderr(level: string, message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}

function writeLine(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * 启动 stdin 监听循环。每行是一个 JSON-RPC Request。
 * 读取 → 解析 → dispatch → 响应。
 */
export function startStdinLoop(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  });

  rl.on('line', (line: string) => {
    if (line.trim() === '') return;
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      logToStderr('error', `invalid JSON: ${line.substring(0, 200)}`);
      return;
    }

    if (req.method === undefined || req.id === undefined) {
      logToStderr('error', `not a valid RPC request: ${line.substring(0, 200)}`);
      return;
    }

    handleRequest(req).catch((e) => {
      sendErrorResponse(req.id, {
        code: -32603,
        message: `internal error: ${(e as Error).message}`,
      });
    });
  });

  rl.on('close', () => {
    logToStderr('info', 'stdin closed, engine shutting down');
    process.exit(0);
  });
}

async function handleRequest(req: RpcRequest): Promise<void> {
  const handler = handlers.get(req.method);
  if (handler === undefined) {
    sendErrorResponse(req.id, {
      code: -32601,
      message: `method not found: ${req.method}`,
    });
    return;
  }

  try {
    const result = await handler(req.params);
    sendResponse(req.id, result);
  } catch (e) {
    const err = e as Error & { code?: string; __rateLimited?: boolean };
    // 统一失败通知：所有 RPC 失败都发一条 error log
    sendNotification('log', {
      level: 'error',
      message: `${req.method} 失败：${err.message}`,
    });
    sendErrorResponse(req.id, {
      code: -32000,
      message: err.message,
      ...(err.code !== undefined ? { data: { code: err.code } } : {}),
    });
  }
}
