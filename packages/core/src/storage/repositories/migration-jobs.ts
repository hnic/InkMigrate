import type { DB } from '../database.js';
import { isJobStatus, canJobTransition, type JobStatus } from '../../domain/states.js';

/**
 * §11.1 跨状态转换 + 自环（同 status 内推进 current_stage）。
 * M9: 矩阵改为引用 domain/states.ts 的单一真相源，消除本地副本漂移。
 */
function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  // 自环（to === from）总是允许：current_stage 在同一 status 内推进（如 running→running
  // 从 scanning 到 extracting）不是状态转换，矩阵只约束跨状态转换。
  if (to === from) return true;
  return canJobTransition(from, to);
}

export interface MigrationJobInput {
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  status: string;
  currentStage: string;
  planId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationJobRow {
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  planId?: string;
  status: string;
  currentStage: string;
  pauseReasonCode?: string;
  pausedAt?: string;
  scanCount: number;
  candidateCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
  conflictCount: number;
  skippedCount: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCountsInput {
  scanCount?: number;
  candidateCount?: number;
  verifiedCount?: number;
  degradedCount?: number;
  failedCount?: number;
  conflictCount?: number;
  skippedCount?: number;
}

export interface UpdateStatusInput {
  status: string;
  currentStage?: string;
  pauseReasonCode?: string | null;
  pausedAt?: string | null;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/**
 * §16.3 migration_jobs 仓储。
 *
 * 计数列是便于显示的缓存（§16.3 字段语义）；Job 完成前核心必须从条目终态
 * 重新派生明细并核对，缓存不是唯一事实来源。这里只提供写入与读取，对账逻辑
 * 由 application 层的 migration-service 负责。
 */
export class MigrationJobs {
  constructor(private db: DB) {}

  create(i: MigrationJobInput): void {
    this.db
      .prepare(
        `INSERT INTO migration_jobs(id,source_instance_id,target_instance_id,plan_id,status,current_stage,scan_count,candidate_count,verified_count,degraded_count,failed_count,conflict_count,skipped_count,created_at,updated_at)
         VALUES(@id,@sourceInstanceId,@targetInstanceId,@planId,@status,@currentStage,0,0,0,0,0,0,0,@createdAt,@updatedAt)`,
      )
      .run({ planId: null, ...i });
  }

  get(id: string): MigrationJobRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_instance_id AS sourceInstanceId, target_instance_id AS targetInstanceId,
                plan_id AS planId, status, current_stage AS currentStage,
                pause_reason_code AS pauseReasonCode, paused_at AS pausedAt,
                scan_count AS scanCount, candidate_count AS candidateCount,
                verified_count AS verifiedCount, degraded_count AS degradedCount,
                failed_count AS failedCount, conflict_count AS conflictCount,
                skipped_count AS skippedCount, started_at AS startedAt,
                finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
         FROM migration_jobs WHERE id=?`,
      )
      .get(id) as MigrationJobRow | undefined;
  }

  /** §16.3 更新缓存计数列。未传入的字段不动。同时刷新 updated_at（与 CleanupJobs.updateCounts 一致）。 */
  updateCounts(id: string, c: UpdateCountsInput): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      sets.push(`${toSnake(k)} = @${k}`);
      params[k] = v;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(
        `UPDATE migration_jobs SET ${sets.join(', ')}, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({ ...params, updatedAt: new Date().toISOString() });
  }

  /**
   * §11.1 更新 Job 生命周期 status、current_stage 与暂停相关字段。
   *
   * 可清空字段（pauseReasonCode/pausedAt/startedAt/finishedAt）使用显式 SET 而非 COALESCE：
   * 调用方传 null 即清空该字段，传值即覆盖，省略（undefined）经 `?? null` 归一为 null。
   * 这样 paused→running 的恢复能正确清除 pause_reason_code/paused_at，避免审计污染。
   *
   * §11.1 状态转换守卫：读取当前 status，按 JOB_TRANSITIONS 校验目标 status 合法性。
   * 终态（completed/failed）的 Job 无法再被改写，断点续跑只能从 paused/interrupted 恢复。
   * 这把规格里的转换矩阵从"纸上规则"升级为运行期强制约束，防止并发/误操作写出非法状态。
   *
   * M1: 未知 status（拼写错误等）直接抛错，而非原实现那样静默跳过守卫直写 DB。
   * 读-校验-写包入事务，消除单连接内的 TOCTOU 窗口。
   */
  updateStatus(id: string, u: UpdateStatusInput): void {
    // M1: 未知 status 直接拒绝——原实现仅在 isJobStatus 为真时校验，非法状态会
    // 绕过守卫直写 DB（配合 schema 缺 CHECK，拼写错误被静默持久化）。
    if (!isJobStatus(u.status)) {
      throw new Error(
        `非法 Job status 值："${u.status}"（id=${id}）；合法值：created/running/paused/interrupted/completed/failed`,
      );
    }
    // 守卫后固化为 JobStatus，供事务闭包内使用（闭包会丢失类型收窄）。
    const targetStatus: JobStatus = u.status;
    // 读-校验-写包入事务，消除 TOCTOU（M1）。
    const txn = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT status FROM migration_jobs WHERE id=?')
        .get(id) as { status: string } | undefined;
      if (current !== undefined && isJobStatus(current.status)) {
        if (!canTransitionTo(current.status, targetStatus)) {
          throw new Error(
            `非法 Job 状态转换：${current.status} → ${targetStatus}（id=${id}）。` +
              `终态（completed/failed）不可再转换；resume 只能从 paused/interrupted 恢复。`,
          );
        }
      }
      this.db
        .prepare(
          `UPDATE migration_jobs
           SET status=@status,
               current_stage=COALESCE(@currentStage, current_stage),
               pause_reason_code=@pauseReasonCode,
               paused_at=@pausedAt,
               started_at=COALESCE(@startedAt, started_at),
               finished_at=COALESCE(@finishedAt, finished_at),
               updated_at=@updatedAt
           WHERE id=@id`,
        )
        .run({
          id,
          status: u.status,
          currentStage: u.currentStage ?? null,
          pauseReasonCode: u.pauseReasonCode ?? null,
          pausedAt: u.pausedAt ?? null,
          startedAt: u.startedAt ?? null,
          finishedAt: u.finishedAt ?? null,
          updatedAt: u.updatedAt,
        });
    });
    txn();
  }
}

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}
