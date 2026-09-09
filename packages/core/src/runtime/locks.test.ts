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

  it('原子获取：文件已存在（含"新鲜"锁）时绝不静默覆盖，必抛 LockConflictError', () => {
    // §缺陷6：当前实现用 existsSync→readFileSync→writeFileSync 非原子，
    // 跨进程抢占时存在 check-then-write 窗口，第二个进程可能在第一个
    // existsSync(false) 之后、writeFileSync 之前创建锁，导致被静默覆盖。
    //
    // 本测试固化原子语义不变量：只要锁文件已存在（无论被谁创建），
    // acquireLock 必须失败而非覆盖——这是 openSync('wx')（EEXIST）的契约，
    // 也是消除 TOCTOU 窗口的可观察属性。
    //
    // 注：真正的跨进程竞态无法在进程内确定性复现（acquireLock 是同步的，
    // 同进程顺序调用不会交错）。此测试覆盖"文件已存在则不覆盖"这一原子
    // 创建的核心保证；跨进程并发由 wx 的 EEXIST 语义在内核层面保证。
    const lockPath = join(dir, 'atomic.lock');
    // 模拟"另一进程刚刚创建"的锁文件（新鲜，非 stale）
    const fresh: LockFileContent = {
      pid: 4242,
      hostname: 'other-host',
      jobId: 'other-job',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    writeFileSync(lockPath, JSON.stringify(fresh));

    expect(() =>
      acquireLock({ locksDir: dir, lockName: 'atomic', jobId: 'me' }),
    ).toThrow(LockConflictError);

    // 锁文件未被覆盖——仍是 other-job 的内容
    const after = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFileContent;
    expect(after.jobId).toBe('other-job');
  });

  it('T-2: 心跳写失败达阈值或锁被接管后 checkHealth 抛 LockHeartbeatError', async () => {
    // C2: 原实现心跳失败时在 setInterval 回调里 throw，会变成未捕获异常 + 锁残留。
    // 改为设置失败标志，由持锁方在主循环调用 checkHealth() 轮询。
    // 心跳经持有期打开的 fd 写入后，「删除锁文件」不再触发写失败，而是被
    // fstatSync(fd).nlink === 0 检测为接管——本测试模拟接管场景（删除 + 以
    // 另一 jobId 重建），验证：checkHealth 抛错、release 不删新持有方的文件。
    const held = acquireLock({
      locksDir: dir,
      lockName: 'takeover-real',
      jobId: 'j1',
      heartbeatMs: 10,
    });
    // 正常情况下 checkHealth 不抛
    expect(() => held.checkHealth()).not.toThrow();
    // 模拟另一进程接管：删除锁文件并以不同 jobId 重建
    const takeover: LockFileContent = {
      pid: 4242,
      hostname: 'other-host',
      jobId: 'other-job',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    rmSync(held.path, { force: true });
    writeFileSync(held.path, JSON.stringify(takeover, null, 2));
    try {
      // 等待足够心跳周期（10ms + 余量）触发 nlink 检测
      await new Promise((r) => setTimeout(r, 60));
      expect(() => held.checkHealth()).toThrow(/接管/);
    } finally {
      held.release();
      // 新持有方的锁文件不被删除
      expect(existsSync(held.path)).toBe(true);
    }
  });

  it('HeldLock.checkHealth 在无失败时是 no-op，release 后调用安全', () => {
    const held = acquireLock({ locksDir: dir, lockName: 'health-ok', jobId: 'j1' });
    expect(typeof held.checkHealth).toBe('function');
    held.checkHealth();
    held.release();
    // release 后再调 checkHealth 不应抛（幂等安全）
    held.checkHealth();
  });
});
