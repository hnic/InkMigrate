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
      if (safeMsg === undefined) {
        fn.call(logger, safeObj);
      } else {
        fn.call(logger, safeObj, safeMsg, ...rest);
      }
    };
  // Logger 是函数与对象的混合体；用 Proxy 拦截已知方法。
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (
        typeof prop === 'string' &&
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(prop)
      ) {
        return wrap(Reflect.get(target, prop, receiver) as (...a: unknown[]) => void);
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
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(val, r);
    }
    return out;
  }
  return v;
}
