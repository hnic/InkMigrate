import { describe, it, expect, vi } from 'vitest';
import {
  withRetry,
  shouldPauseForRateLimit,
  type RetryPolicy,
} from '../../src/runtime/retry.js';

const fastPolicy: RetryPolicy = {
  maxRetries: 3,
  backoffMs: [10, 30, 90],
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
