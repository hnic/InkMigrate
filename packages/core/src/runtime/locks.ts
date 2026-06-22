import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isStaleLock, type LockFileContent } from './lock-content.js';

export interface AcquireOptions {
  /** `.inkmigrate/locks/` 目录路径，调用方根据 `workspace.stateDir` 推导。 */
  locksDir: string;
  /** 锁名，例如 `migration-s1-t1` 或 `cleanup-s1`（§18.4 命名约定）。 */
  lockName: string;
  /** 持有该锁的 Job ID。 */
  jobId: string;
  /** 心跳刷新间隔，默认 1 秒。 */
  heartbeatMs?: number;
}

export interface HeldLock {
  path: string;
  /** 释放锁并停止心跳。多次调用幂等。 */
  release: () => void;
}

/**
 * §18.4 排他锁获取失败时抛出。
 */
export class LockConflictError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'LockConflictError';
  }
}

/**
 * §18.4 文件锁。锁文件位于 `locksDir/<lockName>.lock`，包含 PID、hostname、
 * jobId、启动时间与心跳时间。心跳由定时器周期性刷新，进程异常退出后心跳
 * 停止，下次 `acquireLock` 会通过 `isStaleLock` 识别并安全接管。
 *
 * 同一来源实例只允许一个清理任务；同一 (source, target) 对只允许一个迁移任务。
 */
export function acquireLock(opts: AcquireOptions): HeldLock {
  mkdirSync(opts.locksDir, { recursive: true });
  const path = join(opts.locksDir, `${opts.lockName}.lock`);
  const content: LockFileContent = {
    pid: process.pid,
    hostname: hostname(),
    jobId: opts.jobId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    let existing: LockFileContent;
    try {
      existing = JSON.parse(raw) as LockFileContent;
    } catch {
      // 锁文件损坏 → 视为陈旧并接管
      existing = {
        pid: -1,
        hostname: '',
        jobId: '',
        startedAt: '',
        heartbeatAt: '',
      };
    }
    if (!isStaleLock(existing)) {
      throw new LockConflictError(
        path,
        `lock "${opts.lockName}" held by pid ${existing.pid} job ${existing.jobId}`,
      );
    }
    rmSync(path, { force: true });
  }

  writeFileSync(path, JSON.stringify(content, null, 2));
  const interval = opts.heartbeatMs ?? 1000;
  const beat = setInterval(() => {
    content.heartbeatAt = new Date().toISOString();
    try {
      writeFileSync(path, JSON.stringify(content, null, 2));
    } catch {
      // 心跳写入失败（磁盘满、被外部删除等）：忽略；下次 acquire 会识别陈旧。
    }
  }, interval);

  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(beat);
      rmSync(path, { force: true });
    },
  };
}
