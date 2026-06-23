/**
 * §18.1/§18.2 重试策略。
 *
 * - HTTP 429：先按退避重试；冷却要求超出窗口时 Job 进入 paused。
 * - 404、内容删除等永久错误不重试。
 * - 重试次数独立于条目状态。
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
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const httpStatus = (e as { httpStatus?: number }).httpStatus;
      if (httpStatus !== undefined && isPermanentHttpError(httpStatus)) {
        throw e;
      }
      if (attempt < policy.maxRetries - 1) {
        const delay = policy.backoffMs[attempt] ?? 1000;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** §18.1 默认抓取重试策略。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [3000, 10000, 30000],
};
