import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockConflictError } from './locks.js';
import { isStaleLock, type LockFileContent } from './lock-content.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'locks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock (§18.4)', () => {
  it('acquires a fresh lock and writes lock file with required fields', () => {
    const held = acquireLock({ locksDir: dir, lockName: 'migration-s1-t1', jobId: 'j1' });
    expect(existsSync(held.path)).toBe(true);
    const content = JSON.parse(readFileSync(held.path, 'utf8')) as LockFileContent;
    expect(content.pid).toBe(process.pid);
    expect(content.jobId).toBe('j1');
    expect(content.hostname).toBeTruthy();
    expect(content.startedAt).toBeTruthy();
    expect(content.heartbeatAt).toBeTruthy();
    held.release();
    expect(existsSync(held.path)).toBe(false);
  });

  it('throws LockConflictError when lock is already held (non-stale)', () => {
    const first = acquireLock({ locksDir: dir, lockName: 'x', jobId: 'j1' });
    expect(() =>
      acquireLock({ locksDir: dir, lockName: 'x', jobId: 'j2' }),
    ).toThrow(LockConflictError);
    first.release();
  });

  it('overwrites a stale lock', () => {
    const lockPath = join(dir, 'stale.lock');
    const stale: LockFileContent = {
      pid: 99999,
      hostname: 'dead-host',
      jobId: 'old-job',
      startedAt: '2026-06-22T08:00:00+08:00',
      heartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(stale));
    expect(isStaleLock(stale)).toBe(true);

    const held = acquireLock({ locksDir: dir, lockName: 'stale', jobId: 'new-job' });
    const content = JSON.parse(readFileSync(held.path, 'utf8')) as LockFileContent;
    expect(content.jobId).toBe('new-job');
    held.release();
  });

  it('LockConflictError exposes the lock path', () => {
    const first = acquireLock({ locksDir: dir, lockName: 'p', jobId: 'j1' });
    let err: unknown;
    try {
      acquireLock({ locksDir: dir, lockName: 'p', jobId: 'j2' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockConflictError);
    expect((err as LockConflictError).path).toBe(join(dir, 'p.lock'));
    first.release();
  });
});
