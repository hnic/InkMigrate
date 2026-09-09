import type { DB } from '../database.js';

/** cleanup_plans 为不可变计划，status 仅有一个合法值（schema 有意不加 CHECK，见 §16.8 注释）。 */
export type CleanupPlanStatus = 'created';

export interface CleanupPlanRow {
  id: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  planHash: string;
  configHash: string;
  candidateCount: number;
  excludedCount: number;
  status: CleanupPlanStatus;
  createdAt: string;
}

// Input 与 Row 字段完全一致，收敛为同一形状：新增列时只需改 Row 与两处 SQL，
// 避免 Input 副本与 get() 实际返回静默漂移。
export type CleanupPlanInput = CleanupPlanRow;

/**
 * §16.8 cleanup_plans 仓储。不可变清理计划，关联迁移任务（FK migration_jobs）。
 */
export class CleanupPlans {
  constructor(private db: DB) {}

  /**
   * 插入不可变清理计划。
   * @throws id 重复（PRIMARY KEY）或 sourceInstanceId/migrationJobId 不存在（FK）时，
   *         抛出带上下文的错误（而非裸 SqliteError，便于调用方定位缺失的关联行）。
   */
  create(i: CleanupPlanInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO cleanup_plans(id, source_instance_id, migration_job_id, action, plan_hash, config_hash, candidate_count, excluded_count, status, created_at)
           VALUES(@id, @sourceInstanceId, @migrationJobId, @action, @planHash, @configHash, @candidateCount, @excludedCount, @status, @createdAt)`,
        )
        .run(i);
    } catch (e) {
      throw new Error(
        `写入 cleanup_plans 失败（id=${i.id}, sourceInstanceId=${i.sourceInstanceId}, migrationJobId=${i.migrationJobId}）：${(e as Error).message}`,
      );
    }
  }

  get(id: string): CleanupPlanRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_instance_id AS sourceInstanceId, migration_job_id AS migrationJobId,
                action, plan_hash AS planHash, config_hash AS configHash,
                candidate_count AS candidateCount, excluded_count AS excludedCount,
                status, created_at AS createdAt
         FROM cleanup_plans WHERE id=?`,
      )
      .get(id) as CleanupPlanRow | undefined;
  }
}
