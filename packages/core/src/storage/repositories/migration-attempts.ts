import type { DB } from '../database.js';

export interface ItemAttemptInput {
  migrationJobId: string;
  sourceItemId: number;
  stage: string;
  actionCode: string;
  attemptNo: number;
  startedAt: string;
  candidateQuality?: string;
  candidateSourceContentHash?: string;
  /** §13.9 强制覆盖审计关联的 Artifact */
  targetArtifactId?: number;
  createdAt: string;
}

export interface JobAttemptInput {
  migrationJobId: string;
  stage: string;
  actionCode: string;
  attemptNo: number;
  startedAt: string;
  createdAt: string;
}

export interface FinishAttemptInput {
  success: boolean;
  finishedAt: string;
  errorCode?: string;
  errorMessage?: string;
  /** §13.9 覆盖审计三类哈希；非覆盖路径不传 */
  expectedWrittenFileHash?: string;
  observedPrewriteFileHash?: string;
  resultWrittenFileHash?: string;
}

export interface AttemptRow {
  id: number;
  migration_job_id: string;
  attempt_scope: 'job' | 'item';
  source_item_id: number | null;
  target_artifact_id: number | null;
  stage: string;
  action_code: string;
  attempt_no: number;
  candidate_quality: string | null;
  candidate_degradations_json: string | null;
  candidate_source_content_hash: string | null;
  overwrite_policy: string | null;
  expected_written_file_hash: string | null;
  observed_prewrite_file_hash: string | null;
  result_written_file_hash: string | null;
  audit_metadata_json: string;
  started_at: string;
  finished_at: string | null;
  success: 0 | 1 | null;
  error_code: string | null;
  error_message: string | null;
  http_status: number | null;
  diagnostic_path: string | null;
  created_at: string;
}

/**
 * §16.7 migration_attempts 仓储。
 *
 * 尝试分 Job 级（`source_item_id IS NULL`）和条目级（NOT NULL），由表 CHECK
 * 与两个部分唯一索引共同约束；本仓储对外提供两条独立入口。
 */
export class MigrationAttempts {
  constructor(private db: DB) {}

  createItem(i: ItemAttemptInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,target_artifact_id,stage,action_code,attempt_no,candidate_quality,candidate_source_content_hash,started_at,created_at)
         VALUES(@migrationJobId,'item',@sourceItemId,@targetArtifactId,@stage,@actionCode,@attemptNo,@candidateQuality,@candidateSourceContentHash,@startedAt,@createdAt)`,
      )
      .run({
        targetArtifactId: null,
        candidateQuality: null,
        candidateSourceContentHash: null,
        ...i,
      });
    return Number(result.lastInsertRowid);
  }

  createJob(i: JobAttemptInput): void {
    this.db
      .prepare(
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,stage,action_code,attempt_no,started_at,created_at)
         VALUES(@migrationJobId,'job',NULL,@stage,@actionCode,@attemptNo,@startedAt,@createdAt)`,
      )
      .run(i);
  }

  listByItem(migrationJobId: string, sourceItemId: number): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM migration_attempts
         WHERE migration_job_id=? AND source_item_id=? ORDER BY id`,
      )
      .all(migrationJobId, sourceItemId) as AttemptRow[];
  }

  listByJob(migrationJobId: string): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT * FROM migration_attempts WHERE migration_job_id=? ORDER BY id`,
      )
      .all(migrationJobId) as AttemptRow[];
  }

  /** 关闭一条尝试：写入 success/finishedAt 与可选错误信息或覆盖哈希。 */
  finishAttempt(id: number, f: FinishAttemptInput): void {
    this.db
      .prepare(
        `UPDATE migration_attempts
         SET success=@success,
             finished_at=@finishedAt,
             error_code=@errorCode,
             error_message=@errorMessage,
             expected_written_file_hash=COALESCE(@expectedWrittenFileHash, expected_written_file_hash),
             observed_prewrite_file_hash=COALESCE(@observedPrewriteFileHash, observed_prewrite_file_hash),
             result_written_file_hash=COALESCE(@resultWrittenFileHash, result_written_file_hash)
         WHERE id=@id`,
      )
      .run({
        id,
        success: f.success ? 1 : 0,
        finishedAt: f.finishedAt,
        errorCode: f.errorCode ?? null,
        errorMessage: f.errorMessage ?? null,
        expectedWrittenFileHash: f.expectedWrittenFileHash ?? null,
        observedPrewriteFileHash: f.observedPrewriteFileHash ?? null,
        resultWrittenFileHash: f.resultWrittenFileHash ?? null,
      });
  }
}
