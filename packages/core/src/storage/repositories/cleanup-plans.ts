import type { DB } from '../database.js';

export interface CleanupPlanInput {
  id: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  planHash: string;
  configHash: string;
  candidateCount: number;
  excludedCount: number;
  status: string;
  createdAt: string;
}

export interface CleanupPlanRow {
  id: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  planHash: string;
  configHash: string;
  candidateCount: number;
  excludedCount: number;
  status: string;
  createdAt: string;
}

/**
 * §16.8 cleanup_plans 仓储。不可变清理计划，关联迁移任务（FK migration_jobs）。
 */
export class CleanupPlans {
  constructor(private db: DB) {}

  create(i: CleanupPlanInput): void {
    this.db
      .prepare(
        `INSERT INTO cleanup_plans(id, source_instance_id, migration_job_id, action, plan_hash, config_hash, candidate_count, excluded_count, status, created_at)
         VALUES(@id, @sourceInstanceId, @migrationJobId, @action, @planHash, @configHash, @candidateCount, @excludedCount, @status, @createdAt)`,
      )
      .run(i);
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
