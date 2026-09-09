import type { DB } from '../database.js';
import {
  isCleanupJobStatus,
  canCleanupJobTransition,
  type CleanupJobStatus,
} from '../../domain/states.js';

export interface CleanupJobInput {
  id: string;
  planId: string;
  planHash: string;
  action: string;
  status: string;
  candidateCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
}

export interface CleanupJobRow {
  id: string;
  planId: string;
  planHash: string;
  action: string;
  status: string;
  candidateCount: number;
  processedCount: number;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  unknownCount: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCleanupCountsInput {
  processedCount?: number;
  successCount?: number;
  skippedCount?: number;
  failedCount?: number;
  unknownCount?: number;
}

export interface UpdateCleanupStatusInput {
  status: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/**
 * §16.9 cleanup_jobs 仓储。清理执行作业，含进度计数器与生命周期状态。
 *
 * 计数列为便于显示的缓存；明细事实来源是 cleanup_items。
 */
export class CleanupJobs {
  constructor(private db: DB) {}

  create(i: CleanupJobInput): void {
    // N4：与 updateStatus 同源校验——create 也不能绕过状态机写入任意字符串
    //（schema 无 CHECK，拼写错误会静默持久化并使 updateStatus 守卫失效）。
    if (!isCleanupJobStatus(i.status)) {
      throw new Error(
        `非法 cleanup_job status 值："${i.status}"（id=${i.id}）；合法值：created/running/completed/interrupted`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO cleanup_jobs(id, plan_id, plan_hash, action, status, candidate_count, processed_count, success_count, skipped_count, failed_count, unknown_count, started_at, finished_at, created_at, updated_at)
         VALUES(@id, @planId, @planHash, @action, @status, @candidateCount, 0, 0, 0, 0, 0, @startedAt, NULL, @createdAt, @updatedAt)`,
      )
      // ?? 归一：显式传入的 undefined 不能覆盖 null 默认值（better-sqlite3 拒绝 undefined 绑定值）。
      .run({ ...i, startedAt: i.startedAt ?? null });
  }

  get(id: string): CleanupJobRow | undefined {
    return this.db
      .prepare(
        `SELECT id, plan_id AS planId, plan_hash AS planHash, action, status,
                candidate_count AS candidateCount, processed_count AS processedCount,
                success_count AS successCount, skipped_count AS skippedCount,
                failed_count AS failedCount, unknown_count AS unknownCount,
                started_at AS startedAt, finished_at AS finishedAt,
                created_at AS createdAt, updated_at AS updatedAt
         FROM cleanup_jobs WHERE id=?`,
      )
      .get(id) as CleanupJobRow | undefined;
  }

  /** §16.9 更新缓存计数列。未传入的字段不动。 */
  updateCounts(id: string, c: UpdateCleanupCountsInput): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      // 白名单映射：SET 片段由键名拼接进 SQL，不能依赖调用方类型约束兜底
      const col = UPDATE_COUNT_COLUMNS[k];
      if (col === undefined) {
        throw new Error(`updateCounts: 未知计数字段 "${k}"（id=${id}）`);
      }
      sets.push(`${col} = @${k}`);
      params[k] = v;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE cleanup_jobs SET ${sets.join(', ')}, updated_at=@updatedAt WHERE id=@id`)
      .run({ ...params, updatedAt: new Date().toISOString() });
  }

  /**
   * 更新 Job 生命周期 status 与时间戳。
   *
   * N4: 加状态机守卫（与 migration-jobs.updateStatus 的 M1 修复同模式）——
   * 原实现任意 status 字符串都能写入（配合 schema 缺 CHECK，拼写错误静默持久化）。
   * 现在：未知 status 直接抛错；读-校验-写包入事务消除 TOCTOU。
   */
  updateStatus(id: string, u: UpdateCleanupStatusInput): void {
    if (!isCleanupJobStatus(u.status)) {
      throw new Error(
        `非法 cleanup_job status 值："${u.status}"（id=${id}）；合法值：created/running/completed/interrupted`,
      );
    }
    const targetStatus: CleanupJobStatus = u.status;
    const txn = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT status FROM cleanup_jobs WHERE id=?')
        .get(id) as { status: string } | undefined;
      // 行不存在时抛错而非静默 no-op：UPDATE 影响 0 行会让调用方误以为已落库。
      if (current === undefined) {
        throw new Error(`cleanup_job 不存在：id=${id}，updateStatus 未生效`);
      }
      // 存量 status 非法（脏数据/绕过校验写入）同样拒绝：跳过守卫直写等于放弃状态机保护。
      if (!isCleanupJobStatus(current.status)) {
        throw new Error(
          `cleanup_job 存量 status 非法："${current.status}"（id=${id}），拒绝无守卫更新`,
        );
      }
      if (!canCleanupJobTransition(current.status, targetStatus)) {
        throw new Error(
          `非法 cleanup_job 状态转换：${current.status} → ${targetStatus}（id=${id}）。` +
            `终态（completed/interrupted）不可再转换。`,
        );
      }
      this.db
        .prepare(
          `UPDATE cleanup_jobs
           SET status=@status,
               started_at=COALESCE(@startedAt, started_at),
               finished_at=COALESCE(@finishedAt, finished_at),
               updated_at=@updatedAt
           WHERE id=@id`,
        )
        .run({
          id,
          status: targetStatus,
          startedAt: u.startedAt ?? null,
          finishedAt: u.finishedAt ?? null,
          updatedAt: u.updatedAt,
        });
    });
    txn();
  }
}

/** updateCounts 可更新的计数列白名单（camelCase → snake_case），亦防未知键注入 SET 片段。 */
const UPDATE_COUNT_COLUMNS: Record<string, string> = {
  processedCount: 'processed_count',
  successCount: 'success_count',
  skippedCount: 'skipped_count',
  failedCount: 'failed_count',
  unknownCount: 'unknown_count',
};
