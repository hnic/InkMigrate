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
  maxRetries: number;
  /** 每次重试前的退避毫秒；长度应 >= maxRetries。 */
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
 *   让取消信号能在长退避（最长 30s）期间更快穿透。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
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
      const httpStatus = (e as { httpStatus?: number }).httpStatus;
      const retryable = (e as { retryable?: boolean }).retryable;
      // 显式标记 retryable=false 的错误不重试（如导航超时）
      if (retryable === false) {
        throw e;
      }
      if (httpStatus !== undefined && isPermanentHttpError(httpStatus)) {
        throw e;
      }
      if (attempt < policy.maxRetries - 1) {
        const base = policy.backoffMs[attempt] ?? 1000;
        // §18.1 退避叠加抖动：base×(0.5~1.5) 均匀采样
        await sleep(withJitter(base, RETRY_BACKOFF_JITTER), signal);
      }
    }
  }
  throw lastError;
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

/** §18.1 默认抓取重试策略。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [3000, 10000, 30000],
};
