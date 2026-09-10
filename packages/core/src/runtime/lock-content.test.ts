import { describe, it, expect } from 'vitest';
import { isStaleLock, type LockFileContent } from './lock-content.js';

const fresh = (overrides: Partial<LockFileContent> = {}): LockFileContent => ({
  pid: 12345,
  hostname: 'host',
  jobId: 'j1',
  startedAt: '2026-06-22T10:00:00+08:00',
  heartbeatAt: new Date(Date.now() - 1000).toISOString(),
  ...overrides,
});

describe('isStaleLock (§18.4)', () => {
  it('returns false for a lock with recent heartbeat', () => {
    expect(isStaleLock(fresh())).toBe(false);
  });
  it('returns true when heartbeat is older than threshold', () => {
    const old = fresh({ heartbeatAt: new Date(Date.now() - 120_000).toISOString() });
    expect(isStaleLock(old)).toBe(true);
  });
  it('returns true when heartbeatAt is unparseable', () => {
    expect(isStaleLock(fresh({ heartbeatAt: 'not-a-date' }))).toBe(true);
  });
  it('#311: null/undefined 载荷与非字符串心跳确定性判陈旧（不抛 TypeError）', () => {
    expect(isStaleLock(null)).toBe(true);
    expect(isStaleLock(undefined)).toBe(true);
    expect(isStaleLock({ ...fresh(), heartbeatAt: 123 as unknown as string })).toBe(true);
    expect(isStaleLock(JSON.parse('null') as never)).toBe(true);
  });
  it('#312: 心跳显著超前于本地时钟视为陈旧（跨机时钟偏移/脏数据不卡死锁）', () => {
    const now = Date.now();
    // 超前 1s（正常心跳抖动范围）不判陈旧
    expect(isStaleLock(fresh({ heartbeatAt: new Date(now + 1000).toISOString() }), now)).toBe(false);
    // 超前超过 STALE_MS：now - hb 恒为负、锁永不过期，必须判陈旧
    expect(isStaleLock(fresh({ heartbeatAt: new Date(now + 120_000).toISOString() }), now)).toBe(true);
  });
});
