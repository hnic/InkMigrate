import type { DB } from '../database.js';

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

  get(id: string): MigrationJobRow {
    const r = this.db
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
      .get(id) as MigrationJobRow;
    return r;
  }

  /** §16.3 更新缓存计数列。未传入的字段不动。 */
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
      .prepare(`UPDATE migration_jobs SET ${sets.join(', ')} WHERE id=@id`)
      .run(params);
  }

  /** §11.1 更新 Job 生命周期 status、current_stage 与暂停相关字段。 */
  updateStatus(id: string, u: UpdateStatusInput): void {
    this.db
      .prepare(
        `UPDATE migration_jobs
         SET status=@status,
             current_stage=COALESCE(@currentStage, current_stage),
             pause_reason_code=COALESCE(@pauseReasonCode, pause_reason_code),
             paused_at=COALESCE(@pausedAt, paused_at),
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
  }
}

function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}
