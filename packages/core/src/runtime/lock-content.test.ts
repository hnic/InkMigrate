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
});
