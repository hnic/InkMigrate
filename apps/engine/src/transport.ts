/**
 * JSON-RPC over stdio 传输层。
 *
 * - stdin：按行读取 JSON-RPC Request
 * - stdout：输出 JSON-RPC Response 和 Notification（每行一个 JSON）
 * - stderr：日志输出（不干扰 JSON-RPC 通道）
 */
import * as readline from 'node:readline';
import type { ZodType, ZodError } from 'zod';
import type { RpcRequest, RpcResponse, RpcNotification, RpcError } from './protocol.js';

type RequestHandler = (
  params: Record<string, unknown> | undefined,
) => Promise<unknown>;

interface HandlerEntry {
  handler: RequestHandler;
  /** N7: 可选 zod schema，在 dispatch 前校验 params，替代各 handler 内的散落守卫。 */
  schema: ZodType | undefined;
}

const handlers = new Map<string, HandlerEntry>();

/**
 * 注册一个 RPC method 处理器。
 * N7: 可选 schema 在 dispatch 前校验 params（信任边界），校验失败返回 -32602
 * (invalid params)，替代各 handler 内的散落 requireXxx 守卫。
 */
export function registerMethod(
  method: string,
  handler: RequestHandler,
  schema?: ZodType,
): void {
  handlers.set(method, { handler, schema });
}

/** 发送 Response 到 stdout。 */
export function sendResponse(
  id: string | number,
  result: unknown,
): void {
  // JSON-RPC 2.0 要求 Response 必含 result 成员；handler 返回 undefined 时
  // JSON.stringify 会丢掉该字段，此处补 null 保持响应形状合法。
  const msg: RpcResponse = { jsonrpc: '2.0', id, result: result === undefined ? null : result };
  writeLine(msg, 'response');
}

/** 发送 Error Response 到 stdout。id 为 null 用于无法解析请求时的规范错误响应。 */
export function sendErrorResponse(
  id: string | number | null,
  error: RpcError,
): void {
  // RpcResponse.id 的共享类型未含 null，但 JSON-RPC 2.0 规定 parse error / invalid
  // request 的响应 id 必须为 null，此处按规范构造。
  const msg = { jsonrpc: '2.0', id, error } as RpcResponse;
  writeLine(msg, 'response');
}

/** 发送 Notification 到 stdout（用于进度/日志推送）。 */
export function sendNotification(
  method: string,
  params?: Record<string, unknown>,
): void {
  const msg: RpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
  writeLine(msg, 'notification');
}

/** 发送日志到 stderr（不干扰 stdout JSON 通道）。 */
export function logToStderr(level: string, message: string): void {
  process.stderr.write(`[${level}] ${message}\n`);
}

/** stdout 管道是否已断开（宿主关闭了读端）。断开后静默丢弃写入，避免 EPIPE 崩溃。 */
let stdoutBroken = false;

// 宿主关闭 stdout 读端时（如 Tauri 应用退出），避免 EPIPE 杀进程：监听 'error'
// 事件而非让 Node 默认崩溃。必须在模块加载时就装好——writeLine 内的同步 try/catch
// 兜不住流错误（write 的错误异步经 'error' 事件送达），若等 startStdinLoop 再装，
// 此前任何写入触发的 stdout 错误都没有监听器，unhandled 'error' 会直接终止进程。
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    stdoutBroken = true;
    logToStderr('warn', 'stdout EPIPE（宿主已断开），后续写入将被丢弃');
  } else {
    throw err; // 其他错误不应吞掉
  }
});

/**
 * H6/R4-C1: stdout 背压保护。process.stdout.write 返回 false 表示内核缓冲已满，
 * 应等待 'drain'。若宿主持续不读，Node 内部缓冲会无界增长导致 OOM。
 * 用一个上限计数器：超过阈值后丢弃低优先级的 notification（log/progress），
 * 但**永不丢弃 response/error**（R4-C1: 原实现一律丢弃导致 GUI 永久冻结）。
 */
const STDOUT_HIGH_WATERMARK = 1024 * 1024; // 1 MiB 排队上限
let stdoutBackpressured = false;

function writeLine(msg: unknown, priority: 'response' | 'notification' = 'notification'): void {
  if (stdoutBroken) return; // 管道已断，静默丢弃
  let line: string;
  try {
    line = JSON.stringify(msg) + '\n';
  } catch {
    // 序列化失败（handler 返回 BigInt/循环引用等）：丢弃该消息并记日志。
    // 不能让异常逃逸——否则成功的调用会被外层 catch 误报成 -32000 失败。
    logToStderr('error', 'message serialization failed, dropping write');
    return;
  }
  try {
    // R4-C1: 背压时只丢弃 notification，response/error 必须写入（否则 GUI 永久冻结）
    if (stdoutBackpressured && priority === 'notification') {
      return;
    }
    const ok = process.stdout.write(line);
    if (!ok) {
      // 返回 false：内核缓冲满，进入背压。若累积超水位，进入丢弃模式。
      if (process.stdout.writableLength > STDOUT_HIGH_WATERMARK) {
        stdoutBackpressured = true;
        logToStderr('warn', 'stdout 背压超水位，暂时丢弃 notification 直到 drain');
        // R4-M1: drain 可能永不触发（host 永久慢），加 5s 超时兜底恢复；
        // 超时分支必须摘掉 drain 监听，否则每次背压都永久泄漏一个监听器
        // （累积约 10 次后每次写入都报 MaxListenersExceededWarning）。
        const onDrain = (): void => {
          clearTimeout(drainTimeout);
          stdoutBackpressured = false;
        };
        const drainTimeout = setTimeout(() => {
          process.stdout.removeListener('drain', onDrain);
          stdoutBackpressured = false;
          logToStderr('warn', 'stdout 背压 5s 超时，强制恢复（可能丢失部分 notification）');
        }, 5000);
        process.stdout.once('drain', onDrain);
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
 * H6: 单条 stdin 行的最大字节数。超限在分块读取阶段直接销毁 stdin（见
 * startStdinLoop 内的累计逻辑），防止恶意/异常宿主写超长无换行行撑爆内存。
 * 正常 JSON-RPC 请求远小于此值。
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

  // H6: 行长上限必须在分块读取阶段生效——readline 会把整行（直到换行符）缓存在
  // 内存里，'line' 事件触发时超长行早已全部进入内存，事后按行校验防不住 OOM。
  // 此处按块累计"距最后一个换行符"的字节数，超限即销毁 stdin 中止读取。
  let pendingLineBytes = 0;
  process.stdin.on('data', (chunk: Buffer) => {
    const lastNewline = chunk.lastIndexOf(0x0a);
    pendingLineBytes =
      lastNewline === -1 ? pendingLineBytes + chunk.length : chunk.length - lastNewline - 1;
    if (pendingLineBytes > MAX_LINE_BYTES) {
      logToStderr('error', `line exceeds ${MAX_LINE_BYTES} bytes, stdin destroyed`);
      process.stdin.destroy();
      rl.close(); // 触发下方 close 流程统一退出（stdin destroy 不会自动通知 readline）
    }
  });

  rl.on('line', (line: string) => {
    if (line.trim() === '') return;
    // H6 双保险：正常路径下超长行已在分块阶段拦截，此处再校验一次行长。
    // Buffer.byteLength 计算 UTF-8 字节数（多字节字符占多字节）。
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      logToStderr('error', `line exceeds ${MAX_LINE_BYTES} bytes, rejected`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      logToStderr('error', `invalid JSON: ${line.substring(0, 200)}`);
      // JSON-RPC 2.0：无法解析必须回 -32700（id 为 null）——只记日志不回响应，
      // 会让按 id 关联响应的宿主永久挂起。
      sendErrorResponse(null, { code: -32700, message: 'parse error' });
      return;
    }

    // 非对象（数字/字符串/null/数组等）或缺 method 都不是合法 Request
    if (parsed === null || typeof parsed !== 'object' || (parsed as RpcRequest).method === undefined) {
      logToStderr('error', `not a valid RPC request: ${line.substring(0, 200)}`);
      sendErrorResponse(null, { code: -32600, message: 'invalid request' });
      return;
    }
    const req = parsed as RpcRequest;
    if (req.id === undefined) {
      // 有 method 无 id 是宿主 Notification：本 engine 未支持宿主→engine 通知
      // （所有方法都需回响应，R4-C1），显式丢弃并记日志；规范禁止对 Notification 回错误。
      logToStderr('warn', `host notification is not supported, dropped: ${req.method}`);
      return;
    }

    handleRequest(req).catch((e) => {
      sendErrorResponse(req.id, {
        code: -32603,
        message: `internal error: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  });

  rl.on('close', () => {
    logToStderr('info', 'stdin closed, engine shutting down');
    // 等待 stdout 缓冲排空后再退出（有界宽限），避免丢弃已写入的最终响应——
    // stdin 关闭不代表宿主停止读取 stdout。
    const done = (): void => process.exit(0);
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', done);
      setTimeout(done, 1000).unref();
    } else {
      done();
    }
  });
}

async function handleRequest(req: RpcRequest): Promise<void> {
  const entry = handlers.get(req.method);
  if (entry === undefined) {
    sendErrorResponse(req.id, {
      code: -32601,
      message: `method not found: ${req.method}`,
    });
    return;
  }

  // N7: schema 校验（信任边界）——在 dispatch 前拒绝非法 params
  // R4-M2: 传 parsed.data 而非原始 req.params（原传未校验对象，zod 的 strip 无效）
  let dispatchParams = req.params;
  if (entry.schema !== undefined) {
    const parsed = entry.schema.safeParse(req.params);
    if (!parsed.success) {
      const zErr = parsed.error as ZodError;
      sendErrorResponse(req.id, {
        code: -32602,
        message: `invalid params: ${zErr.errors.map((e: { message: string }) => e.message).join('; ')}`,
      });
      return;
    }
    dispatchParams = parsed.data as Record<string, unknown> | undefined;
  }

  try {
    const result = await entry.handler(dispatchParams);
    sendResponse(req.id, result);
  } catch (e) {
    // 非 Error 抛出值（throw 'x' / reject(null)）没有 message 字段：先规范化，
    // 否则日志显示"失败：undefined"，且 JSON.stringify 会丢掉 undefined 的
    // message 字段（违反 JSON-RPC 2.0 对 error.message 的要求）。
    const err = (e instanceof Error ? e : new Error(String(e))) as Error & { code?: string };
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
