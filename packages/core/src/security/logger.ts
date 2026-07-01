import pino, { type Logger } from 'pino';
import { createRedactor, type Redactor } from './redactor.js';

export interface LoggerOptions {
  level?: string;
  /** 默认 true；对所有 message 与 string 字段做 §19.2 脱敏。 */
  redact?: boolean;
  /** JSONL 输出文件路径（可选）。 */
  destination?: string;
}

/**
 * §20.1 日志工厂。返回 Pino logger；日志字段遵循 §20.1 列表（timestamp/level/
 * job_id/source_instance_id/target_instance_id/source_item_id/stage/event_code/
 * message/duration_ms/retry_count）。
 *
 * 启用 redact 时，对所有字符串字段做 §19.2 脱敏。脱敏只针对字符串值；
 * 非字符串字段原样输出。
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const baseLogger = pino({
    level: opts.level ?? 'info',
    // §20.1 自定义字段而非默认 pid/hostname；这里清空 base。
    base: {},
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...(opts.destination
      ? { transport: { target: 'pino/file', options: { destination: opts.destination, mkdir: true } } }
      : {}),
  });
  if (opts.redact === false) return baseLogger;
  return wrapRedacted(baseLogger, createRedactor());
}

function wrapRedacted(logger: Logger, redactor: Redactor): Logger {
  const wrap =
    (fn: (...args: unknown[]) => void) =>
    (objOrMsg: unknown, msg?: string, ...rest: unknown[]): void => {
      const safeObj =
        typeof objOrMsg === 'string'
          ? redactor(objOrMsg)
          : redactValue(objOrMsg, redactor);
      const safeMsg = msg !== undefined ? redactor(msg) : undefined;
      // H3: printf 风格的 rest 插值参数（如 log.info({url}, 'fetched %s', token)）
      // 也需脱敏，否则会泄漏。
      const safeRest = rest.map((x) => (typeof x === 'string' ? redactor(x) : redactValue(x, redactor)));
      if (safeMsg === undefined) {
        fn.call(logger, safeObj);
      } else {
        fn.call(logger, safeObj, safeMsg, ...safeRest);
      }
    };
  // Logger 是函数与对象的混合体；用 Proxy 拦截已知方法。
  // H1: 必须同时拦截 child() —— Pino 的 logger.child() 返回新的未包装 logger，
  // 任何 logger.child({...}).info(...) 会写未脱敏内容，静默击穿 redact 保证。
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (
        typeof prop === 'string' &&
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(prop)
      ) {
        return wrap(Reflect.get(target, prop, receiver) as (...a: unknown[]) => void);
      }
      // 拦截 child：返回的子 logger 递归包装（共享同一 redactor）。
      if (prop === 'child') {
        const origChild = Reflect.get(target, prop, receiver) as Logger['child'];
        return (...args: Parameters<Logger['child']>) =>
          wrapRedacted(origChild.apply(target, args) as unknown as Logger, redactor);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Logger;
}

function redactValue(v: unknown, r: Redactor): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, r));
  if (typeof v === 'object') {
    // L3: Map/Set/Error.cause 等非普通对象，Object.entries 不遍历其内部条目，
    // 需显式处理避免泄漏。Error 的 message/stack 是可枚举的（已被上面分支覆盖），
    // 但 Error.cause 需递归；Map/Set 转 entry 处理。
    if (v instanceof Map) {
      const out = new Map();
      for (const [k, val] of v) out.set(redactValue(k, r), redactValue(val, r));
      return out;
    }
    if (v instanceof Set) {
      return new Set([...v].map((x) => redactValue(x, r)));
    }
    if (v instanceof Error) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = redactValue(val, r);
      }
      // Error.cause 可能是嵌套 Error 或含敏感信息，递归处理
      if (v.cause !== undefined) {
        out.cause = redactValue(v.cause, r);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val, r);
    }
    return out;
  }
  return v;
}
