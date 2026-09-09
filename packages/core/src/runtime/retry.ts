import { withJitter, RETRY_BACKOFF_JITTER } from './jitter.js';

/**
 * §18.1/§18.2 重试策略。
 *
 * - HTTP 429：先按退避重试；冷却要求超出窗口时 Job 进入 paused。
 * - 404、内容删除等永久错误不重试。
 * - 重试次数独立于条目状态。
 * - §18.1 退避时长叠加抖动（±50%），避免固定退避被风控识别为自动化。
 */
export interface RetryPolicy {
  /**
   * 最多尝试次数（含首次）。名为 maxRetries 是沿用通用惯例，但此处的语义是
   * "总尝试上限"：maxRetries=3 表示首次 + 最多 2 次重试 = 总 3 次调用。
   *（循环 `for attempt < maxRetries` 据此实现。）
   */
  maxRetries: number;
  /** 每次重试前的退避毫秒；长度应 >= maxRetries - 1（首次不退避）。 */
  backoffMs: readonly number[];
}

/** HTTP 状态码是否表示限流，应考虑让 Job 进入 paused。 */
export function shouldPauseForRateLimit(httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus === 503;
}

/**
 * H8: 限流错误（HTTP 429/503）。用 Error 子类替代原「抛普通对象 + 魔法属性
 * __rateLimited」——后者丢失栈、instanceof Error 失败，且与 shouldPauseForRateLimit
 * 形成两份独立判断会漂移。此处通过 isRateLimitedError 复用同一判定源。
 */
export class RateLimitedError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    // H8 单一判定源：构造期即校验状态码，防止任意 httpStatus（如 500）构造出
    // 「限流错误」后通过 instanceof 判定被当作应触发 Job paused 的限流条件。
    if (!shouldPauseForRateLimit(httpStatus)) {
      throw new TypeError(
        `RateLimitedError: httpStatus ${httpStatus} 不是限流状态码（仅 429/503）`,
      );
    }
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** 判断错误是否为限流错误（单一判定源，供 job-runner 复用，消除漂移）。 */
export function isRateLimitedError(e: unknown): e is RateLimitedError {
  return e instanceof RateLimitedError;
}

/**
 * M-7: 取消错误。替代原魔法字符串 e.message === 'aborted'（与 H8 的 RateLimitedError
 * 同理）——业务错误恰好 message 为 'aborted' 会被误判为取消。
 */
export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 判断错误是否为取消错误。 */
export function isAbortError(e: unknown): e is AbortError {
  // R3-M1: 除本地 AbortError 类外，也匹配原生 DOMException(name='AbortError')
  //（adapter 用 signal.throwIfAborted() 或 fetch({signal}) 抛的原生 abort）。
  if (e instanceof AbortError) return true;
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

/** HTTP 状态码是否表示永久错误，不应重试。 */
export function isPermanentHttpError(httpStatus: number): boolean {
  return httpStatus === 404 || httpStatus === 410 || httpStatus === 403;
}

/**
 * 对异步函数 `fn` 执行重试。
 *
 * - 永久错误（httpStatus 404/410/403）立即抛出，不重试。
 * - 其它错误按 `policy.backoffMs` 退避后重试，最多 `maxRetries` 次。
 * - 耗尽后抛出最后一次错误。
 * - 可选 `signal`：在重试退避等待期间若被 abort，立即抛出 AbortError 而非等满退避时长，
 *   让取消信号能在长退避（默认策略最长 10s，叠加 ±50% 抖动后约 15s）期间更快穿透。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  // 策略校验：maxRetries <= 0 会让循环体一次都不执行并 throw undefined（丢失全部
  // 诊断信息）；backoffMs 过短此前由 `?? 1000` 静默兜底，掩盖配置漂移。统一快速失败。
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 1) {
    throw new TypeError(
      `withRetry: maxRetries 必须为 >= 1 的整数（收到 ${policy.maxRetries}）`,
    );
  }
  if (policy.backoffMs.length < policy.maxRetries - 1) {
    throw new TypeError(
      `withRetry: backoffMs 长度（${policy.backoffMs.length}）必须 >= maxRetries - 1（${policy.maxRetries - 1}）`,
    );
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxRetries; attempt++) {
    // 每次尝试前检查取消：避免在已取消时仍发起一次新的 extract。
    if (signal?.aborted) throw new AbortError();
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      // 取消信号优先于重试决策
      if (signal?.aborted) throw new AbortError();
      // R4-C2: adapter 自身抛的 AbortError（非 signal 触发）也不重试——
      // 否则取消一个 in-flight extract 会浪费 3 轮退避重试。
      if (isAbortError(e)) throw e;
      const httpStatus = numberProp(e, 'httpStatus');
      const retryable = booleanProp(e, 'retryable');
      // 显式标记 retryable=false 的错误不重试（如导航超时）
      if (retryable === false) {
        throw e;
      }
      if (httpStatus !== undefined && isPermanentHttpError(httpStatus)) {
        throw e;
      }
      if (attempt < policy.maxRetries - 1) {
        // 入口已校验 backoffMs 覆盖 maxRetries-1，此处必存在
        const base = policy.backoffMs[attempt]!;
        // §18.1 退避叠加抖动：base×(0.5~1.5) 均匀采样
        await sleep(withJitter(base, RETRY_BACKOFF_JITTER), signal);
      }
    }
  }
  throw lastError;
}

/**
 * 读取错误对象上的可选数字属性（duck-typed 的 httpStatus 等）。adapter 抛出的
 * 错误形态不受控：属性可能缺失或类型不符（如字符串 '404'），运行时校验类型，
 * 非数字视为缺失，避免真值但非数字的值绕过 isPermanentHttpError 等判定。
 */
function numberProp(e: unknown, key: string): number | undefined {
  const v = (e as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** 同 numberProp，读取可选布尔属性（如 retryable）；非布尔视为缺失。 */
function booleanProp(e: unknown, key: string): boolean | undefined {
  const v = (e as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((r) => setTimeout(r, ms));
  }
  // 已取消则立即拒绝，不等满 ms
  if (signal.aborted) return Promise.reject(new AbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new AbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * §18.1 默认抓取重试策略。
 * maxRetries=3：首次 + 最多 2 次重试。backoffMs 对应每次重试前的退避
 *（首次不退避，故只需 maxRetries-1=2 个值）。此前 backoffMs 有 3 个值，
 * 第 3 个（30000ms）因循环只跑 maxRetries 次而永不使用，是死配置——已修正。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [3000, 10000],
};
