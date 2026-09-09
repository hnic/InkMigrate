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
  // 从实例取全部 level（含 customLevels，如 security/audit），而非硬编码六个
  // 方法名——自定义 level 的方法若不拦截，会成为绕过脱敏的旁路。
  const levelMethods = new Set(Object.keys(logger.levels.values));
  const wrapCache = new Map<
    string,
    (objOrMsg: unknown, msg?: string, ...rest: unknown[]) => void
  >();
  const wrap =
    (fn: (...args: unknown[]) => void) =>
    (objOrMsg: unknown, msg?: string, ...rest: unknown[]): void => {
      // 脱敏路径可能因用户 getter 等抛错；此时既不能丢日志、更不能把异常抛回
      // 调用方（catch 块里的 logger.error 会掩盖原始错误）。降级为占位符，
      // 严禁回退输出原值。
      try {
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
      } catch {
        fn.call(logger, '[redaction failed — payload suppressed]');
      }
    };
  // Logger 是函数与对象的混合体；用 Proxy 拦截已知方法。
  // H1: 必须同时拦截 child() —— Pino 的 logger.child() 返回新的未包装 logger，
  // 任何 logger.child({...}).info(...) 会写未脱敏内容，静默击穿 redact 保证。
  return new Proxy(logger, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && levelMethods.has(prop)) {
        // 缓存包装闭包：同一方法多次属性访问不再重复分配。
        let wrapped = wrapCache.get(prop);
        if (wrapped === undefined) {
          wrapped = wrap(Reflect.get(target, prop, receiver) as (...a: unknown[]) => void);
          wrapCache.set(prop, wrapped);
        }
        return wrapped;
      }
      // 拦截 child：返回的子 logger 递归包装（共享同一 redactor）。
      if (prop === 'child') {
        const origChild = Reflect.get(target, prop, receiver) as Logger['child'];
        return (...args: Parameters<Logger['child']>) => {
          const [bindings, ...rest] = args;
          // Pino 在 child() 内部把 bindings 序列化进 chindings，前置到该 child 的
          // 每一行日志——方法级拦截看不到这些字段，必须在传入前脱敏，否则
          // logger.child({ token }).info(...) 会在每一行泄漏原始 token。
          const safeBindings = redactValue(bindings, redactor) as typeof bindings;
          return wrapRedacted(
            origChild.apply(target, [safeBindings, ...rest] as Parameters<Logger['child']>) as unknown as Logger,
            redactor,
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Logger;
}

function redactValue(v: unknown, r: Redactor, ancestors: object[] = []): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return r(v);
  // H-3/R3-H2: 循环引用守卫。用祖先路径判环而非全量 WeakSet：后者会把 DAG 中
  // 被多处共享的普通对象（{req:{meta},res:{meta}}）误标 [Circular]，腐蚀合法数据；
  // 祖先路径只剪断真正的回边。
  if (typeof v === 'object') {
    if (ancestors.includes(v as object)) {
      return '[Circular]';
    }
    ancestors.push(v as object);
    try {
      if (Array.isArray(v)) {
        // R3-H2: 数组同样进入祖先链，递归传同一数组
        return v.map((x) => redactValue(x, r, ancestors));
      }
      // 常见内建类型短路：Date/RegExp 的数据在内部槽，Object.entries 拿不到
      //（会序列化成 {}）；Buffer/TypedArray 会被逐字节展开成海量数字属性。
      if (v instanceof Date) return v.toISOString();
      if (v instanceof RegExp) return v.toString();
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        return '[binary data]';
      }
      // L3: Map/Set/Error.cause 等非普通对象，Object.entries 不遍历其内部条目，
      // 需显式处理避免泄漏。
      if (v instanceof Map) {
        const out = new Map();
        for (const [k, val] of v) out.set(redactValue(k, r, ancestors), redactValue(val, r, ancestors));
        return out;
      }
      if (v instanceof Set) {
        return new Set([...v].map((x) => redactValue(x, r, ancestors)));
      }
      if (v instanceof Error) {
        const out: Record<string, unknown> = {};
        // message/stack/name 是非枚举 own 属性，Object.entries 取不到，必须显式
        // 带出，否则 logger.error({ err }) 输出近乎 {}，丢失最关键的诊断信息。
        // message/stack 可能含敏感串（URL 内嵌 token、家目录路径），同样过脱敏。
        out.name = v.name;
        out.message = r(v.message);
        if (v.stack !== undefined) out.stack = r(v.stack);
        for (const [k, val] of Object.entries(v)) {
          out[k] = redactValue(val, r, ancestors);
        }
        // Error.cause 可能是嵌套 Error 或含敏感信息，递归处理
        if (v.cause !== undefined) {
          out.cause = redactValue(v.cause, r, ancestors);
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = redactValue(val, r, ancestors);
      }
      return out;
    } finally {
      ancestors.pop();
    }
  }
  return v;
}
