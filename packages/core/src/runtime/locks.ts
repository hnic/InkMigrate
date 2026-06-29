import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
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

  // §缺陷6（TOCTOU）：原实现 existsSync → readFileSync → writeFileSync 非原子，
  // 跨进程抢占（CLI 与 engine 同时启动）时，两个进程都可能观察到"锁不存在"
  // 而后各自 writeFileSync 创建成功，导致锁失效。
  //
  // 改为原子创建（openSync 'wx'）：文件已存在时内核直接返回 EEXIST，check 与
  // create 之间不存在可被另一进程插入的窗口。陈旧锁（进程异常退出、心跳停止）
  // 先识别并移除，再原子创建；移除后若另一进程抢先创建，本次 openSync('wx')
  // 抛 EEXIST → 转为 LockConflictError，语义与"锁被他人持有"一致。
  const acquireAtomically = (): void => {
    let fd: number;
    try {
      fd = openSync(path, 'wx'); // 排他创建：已存在即 EEXIST
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new LockConflictError(path, `lock "${opts.lockName}" already exists`);
      }
      throw e;
    }
    // 拿到独占 fd 后直接写入该 fd（避免再次按路径 open 的潜在截断竞态）；
    // 写入失败仍视为已持有（fd 已创建，锁文件已存在）
    try {
      writeFileSync(fd, JSON.stringify(content, null, 2));
    } finally {
      closeSync(fd);
    }
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

  acquireAtomically();
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
      // 竞态防护：只删除自己持有的锁。如果锁已被其他进程接管（jobId 不同），不删除。
      if (existsSync(path)) {
        try {
          const raw = readFileSync(path, 'utf8');
          const current = JSON.parse(raw) as LockFileContent;
          if (current.jobId === opts.jobId) {
            rmSync(path, { force: true });
          }
        } catch {
          // 锁文件损坏或无法读取，安全删除
          rmSync(path, { force: true });
        }
      }
    },
  };
}
