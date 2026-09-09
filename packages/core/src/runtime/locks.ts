import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  writeSync,
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

/**
 * 心跳持续写入失败、或锁文件被其他进程接管时由 {@link HeldLock.checkHealth}
 * 抛出，供持锁方在主循环中（而非 setInterval 回调中）轮询，避免回调内抛错
 * 变成未捕获异常。
 */
export class LockHeartbeatError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'LockHeartbeatError';
  }
}

export interface HeldLock {
  path: string;
  /** 释放锁并停止心跳。多次调用幂等。 */
  release: () => void;
  /**
   * 心跳健康检查。心跳连续写入失败达阈值、或检测到锁文件已被其他进程接管时
   * 抛出 {@link LockHeartbeatError}，否则正常返回。持锁方应在主循环（而非
   * 信号/定时器回调）中周期性调用。
   */
  checkHealth: () => void;
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
 *
 * 心跳经持有期一直打开的 fd 写入（而非按路径写）：锁被他人接管（文件被 rm 后
 * 重建）时，写入落在已 unlink 的孤儿 inode 上，不会污染新持有方的锁文件；
 * fstatSync(fd).nlink === 0 即检测到接管，主动停止心跳并放弃锁。
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
  const acquireAtomically = (): number => {
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
    // fd 持有期保持打开：心跳经该 fd 写入（见 beat），锁文件被接管删除后写入
    // 落在已 unlink 的孤儿 inode 上，且 fstatSync(fd).nlink === 0 可检测接管。
    try {
      writeFileSync(fd, JSON.stringify(content, null, 2));
    } catch (e) {
      // 首次写入失败：清理刚创建的空锁文件再抛出，否则残留文件会让本锁的
      // 后续获取永远失败（调用方拿不到 HeldLock，无人释放）。
      rmSync(path, { force: true });
      closeSync(fd);
      throw e;
    }
    return fd;
  };

  let raw: string | undefined;
  if (existsSync(path)) {
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      // existsSync 与 readFileSync 之间存在 ENOENT 竞态（他进程接管时已删除）：
      // 视为无锁，走下方原子创建；其余读取错误如实抛出。
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  if (raw !== undefined) {
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

  const fd = acquireAtomically();
  const interval = opts.heartbeatMs ?? 1000;
  // I9: 心跳连续写失败计数。磁盘满/权限问题致心跳持续写失败时，锁会被误判陈旧并被
  // 另一进程接管，而本进程仍以为持锁 → 两进程并发写同一 (source,target)，破坏唯一约束。
  // 连续失败达阈值时标记失败（不再在 setInterval 回调里抛错——那会变成未捕获异常，
  // 既不触发持锁方 finally，也不释放锁文件，导致进程崩溃 + 锁残留）。
  // 改为设置 failed 标志，由持锁方在主循环中调用 checkHealth() 轮询并优雅失败。
  let heartbeatFailures = 0;
  const HEARTBEAT_FAILURE_THRESHOLD = 3;
  let released = false;
  let heartbeatFailureMessage: string | undefined;
  const beat = (): void => {
    // I10: release() 后排队中的 beat 可能重建已释放锁文件，首行检查 released。
    if (released || heartbeatFailureMessage !== undefined) return;
    try {
      // 接管检测：nlink === 0 说明本进程的锁文件已被他人删除（接管）。经 fd 写入
      // 虽无害（落在孤儿 inode 上），但本进程已不再持锁——立即标记失败并停止
      // 心跳，让持锁方在下次 checkHealth 时放弃锁，避免双进程并发写入。
      if (fstatSync(fd).nlink === 0) {
        heartbeatFailureMessage = `锁文件已被其他进程接管（${path}），本进程不再持有；为避免双进程并发写入，主动放弃锁。`;
        clearInterval(timer);
        return;
      }
      content.heartbeatAt = new Date().toISOString();
      // 经 fd 定位写入（单次 write 原地覆盖，再截断到新长度——内容为同构 JSON、
      // 时间戳等长，截断仅作防御），不经路径：路径可能已指向新持有方的锁文件。
      const buf = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
      writeSync(fd, buf, 0, buf.length, 0);
      ftruncateSync(fd, buf.length);
      heartbeatFailures = 0;
    } catch {
      heartbeatFailures++;
      if (heartbeatFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
        // 心跳持续写失败：记录失败信息并停止心跳（让 Job 在下次 checkHealth 时失败）。
        // 不在此处抛错（setInterval 回调内的 throw 会变成未捕获异常），
        // 也不在此 release（finally 会在 Job 退出时统一释放）。
        heartbeatFailureMessage =
          `锁心跳连续 ${heartbeatFailures} 次写入失败（${path}），可能磁盘满或权限问题；` +
          `为避免双进程并发写入，主动放弃锁。`;
        clearInterval(timer);
      }
    }
  };
  const timer = setInterval(beat, interval);
  // unref：心跳定时器不应阻止进程退出。若 Job 因异常路径未调 release()（finally
  // 未覆盖的崩溃），未 unref 的 setInterval 会让进程"挂住"。unref 后只要主任务完成，
  // 进程即可退出，定时器在主循环活跃期间仍正常触发心跳。
  timer.unref();

  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        // 接管检测同 beat()：nlink === 0 说明锁文件已被他人删除重建，
        // 路径上的文件属于新持有方，绝不能删除。
        if (fstatSync(fd).nlink === 0) {
          return;
        }
        // 竞态防护：只删除自己持有的锁（Windows 上 nlink 不反映 unlink，
        // jobId 复核仍必要）。读取/解析失败时不删除——可能是新持有方心跳
        // 写入的中间态，误删会让第三个进程并发获取。
        if (existsSync(path)) {
          try {
            const raw2 = readFileSync(path, 'utf8');
            const current = JSON.parse(raw2) as LockFileContent;
            if (current.jobId === opts.jobId) {
              rmSync(path, { force: true });
            }
          } catch {
            // 读取/解析失败：不删除，避免误删他人锁文件
          }
        }
      } finally {
        closeSync(fd);
      }
    },
    checkHealth: () => {
      if (heartbeatFailureMessage !== undefined) {
        throw new LockHeartbeatError(path, heartbeatFailureMessage);
      }
    },
  };
}
