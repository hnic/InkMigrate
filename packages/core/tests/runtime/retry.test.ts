import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  shouldPauseForRateLimit,
  RateLimitedError,
  isRateLimitedError,
  AbortError,
  isAbortError,
  type RetryPolicy,
} from '../../src/runtime/retry.js';
import { RETRY_BACKOFF_JITTER } from '../../src/runtime/jitter.js';

const fastPolicy: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [10, 30], // maxRetries-1=2 个值（首次不退避）
};

describe('withRetry (§18.1/§18.2)', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, fastPolicy);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, fastPolicy);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after maxRetries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    await expect(withRetry(fn, fastPolicy)).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-retryable error (404)', async () => {
    const err = Object.assign(new Error('not found'), { httpStatus: 404 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, fastPolicy)).rejects.toThrow('not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('§18.1 退避叠加抖动：random 固定时退避时长可预测', async () => {
    // 固定 Math.random=0.5 → factor=1（不抖动）→ 退避等于 base
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delays: number[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((cb: () => void, ms?: number) => {
        if (typeof ms === 'number') delays.push(ms);
        // 立即触发，不真等
        cb();
        return {} as NodeJS.Timeout;
      }) as typeof setTimeout);
    try {
      const fn = vi.fn().mockRejectedValue(new Error('always fail'));
      await expect(withRetry(fn, fastPolicy)).rejects.toThrow('always fail');
      // 两次退避（第 1、2 次失败后），random=0.5 → factor=1 → base 原值
      expect(delays).toEqual([10, 30]);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('§18.1 退避叠加抖动：random=1 时取上界 base×(1+jitter)', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const delays: number[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((cb: () => void, ms?: number) => {
        if (typeof ms === 'number') delays.push(ms);
        cb();
        return {} as NodeJS.Timeout;
      }) as typeof setTimeout);
    try {
      const fn = vi.fn().mockRejectedValue(new Error('always fail'));
      await expect(withRetry(fn, fastPolicy)).rejects.toThrow('always fail');
      // base=10 → 10*1.5=15；base=30 → 30*1.5=45
      expect(delays).toEqual([
        Math.round(10 * (1 + RETRY_BACKOFF_JITTER)),
        Math.round(30 * (1 + RETRY_BACKOFF_JITTER)),
      ]);
    } finally {
      randomSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});

describe('shouldPauseForRateLimit (§18.2)', () => {
  it('returns false for 200', () => {
    expect(shouldPauseForRateLimit(200)).toBe(false);
  });
  it('returns false for 404', () => {
    expect(shouldPauseForRateLimit(404)).toBe(false);
  });
  it('returns true for 429', () => {
    expect(shouldPauseForRateLimit(429)).toBe(true);
  });
  it('returns true for 503', () => {
    expect(shouldPauseForRateLimit(503)).toBe(true);
  });
});

describe('RateLimitedError (H8, T-3)', () => {
  it('is an Error instance with correct name and httpStatus', () => {
    const err = new RateLimitedError(429, 'rate limited');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitedError');
    expect(err.httpStatus).toBe(429);
    expect(err.message).toBe('rate limited');
  });
  it('isRateLimitedError type guard', () => {
    expect(isRateLimitedError(new RateLimitedError(503, 'x'))).toBe(true);
    expect(isRateLimitedError(new Error('x'))).toBe(false);
    expect(isRateLimitedError({ httpStatus: 429 })).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe('AbortError (M-7, T-3)', () => {
  it('is an Error instance with correct name', () => {
    const err = new AbortError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('aborted');
  });
  it('isAbortError type guard', () => {
    expect(isAbortError(new AbortError())).toBe(true);
    // M-7: 业务错误恰好 message='aborted' 不应被误判（原魔法字符串会误判）
    expect(isAbortError(new Error('aborted'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
  it('R3-M1: isAbortError 覆盖原生 DOMException(name=AbortError)', () => {
    // adapter 用 signal.throwIfAborted() 抛原生 AbortError（DOMException）
    const nativeAbort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(isAbortError(nativeAbort)).toBe(true);
    // 普通 name 不匹配
    expect(isAbortError(Object.assign(new Error('x'), { name: 'TypeError' }))).toBe(false);
  });
});
