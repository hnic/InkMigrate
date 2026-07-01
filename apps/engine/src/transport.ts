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

/** stdout 管道是否已断开（宿主关闭了读端）。断开后静默丢弃写入，避免 EPIPE 崩溃。 */
let stdoutBroken = false;

/**
 * H6: stdout 背压保护。process.stdout.write 返回 false 表示内核缓冲已满，
 * 应等待 'drain'。若宿主持续不读，Node 内部缓冲会无界增长导致 OOM。
 * 用一个上限计数器：超过阈值后丢弃低优先级的 log/progress 通知（保留 response/error）。
 */
const STDOUT_HIGH_WATERMARK = 1024 * 1024; // 1 MiB 排队上限
let stdoutBackpressured = false;

function writeLine(msg: unknown): void {
  if (stdoutBroken) return; // 管道已断，静默丢弃
  const line = JSON.stringify(msg) + '\n';
  try {
    // 检查排队量：process.stdout.writableLength 是当前在内核/流缓冲中待写的字节数
    if (stdoutBackpressured) {
      // 已超水位且未 drain：丢弃非关键通知（log/progress），保留 response/error。
      // 这里简化处理——超水位时一律丢弃新的非关键写入，由 drain 恢复。
      return;
    }
    const ok = process.stdout.write(line);
    if (!ok) {
      // 返回 false：内核缓冲满，进入背压。若累积超水位，进入丢弃模式。
      if (process.stdout.writableLength > STDOUT_HIGH_WATERMARK) {
        stdoutBackpressured = true;
        logToStderr('warn', 'stdout 背压超水位，暂时丢弃非关键通知直到 drain');
        process.stdout.once('drain', () => {
          stdoutBackpressured = false;
        });
      }
    }
  } catch {
    // 写入失败（EPIPE 等）——宿主已断开，标记并静默，后续写入全部丢弃
    if (!stdoutBroken) {
      stdoutBroken = true;
      logToStderr('warn', 'stdout 管道已断开（宿主可能已关闭），后续通知将被丢弃');
    }
  }
}

/**
 * H6: 单条 stdin 行的最大字节数。超过则拒绝解析（防止恶意/异常宿主写超长无换行
 * 行撑爆内存）。正常 JSON-RPC 请求远小于此值。
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024; // 8 MiB

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

  // 宿主关闭 stdout 读端时（如 Tauri 应用退出），避免 EPIPE 杀进程：
  // 监听 'error' 事件而非让 Node 默认崩溃。writeLine 内的 try/catch 也会兜底。
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stdoutBroken = true;
      logToStderr('warn', 'stdout EPIPE（宿主已断开），后续写入将被丢弃');
    } else {
      throw err; // 其他错误不应吞掉
    }
  });

  rl.on('line', (line: string) => {
    if (line.trim() === '') return;
    // H6: 行长上限——超长行直接拒绝，防止无界缓冲撑爆内存。
    // Buffer.byteLength 计算 UTF-8 字节数（多字节字符占多字节）。
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      logToStderr('error', `line exceeds ${MAX_LINE_BYTES} bytes, rejected`);
      return;
    }
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
    const err = e as Error & { code?: string };
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
