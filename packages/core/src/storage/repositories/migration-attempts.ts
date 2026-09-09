import type { DB } from '../database.js';

export interface ItemAttemptInput {
  migrationJobId: string;
  sourceItemId: number;
  stage: string;
  actionCode: string;
  attemptNo: number;
  startedAt: string;
  candidateQuality?: string;
  /** §13.9 候选降级清单 JSON。提交本轮尝试的 degradations 以补全审计链。 */
  candidateDegradationsJson?: string;
  candidateSourceContentHash?: string;
  /** §13.9 本轮覆盖策略（write_canonical/forced_overwrite/metadata_only 等）。 */
  overwritePolicy?: string;
  /** §20 诊断/审计元数据 JSON。 */
  auditMetadataJson?: string;
  /** §13.9 触发本轮尝试的 HTTP 状态码（限流/4xx/5xx）。 */
  httpStatus?: number;
  /** §20 诊断产物路径。 */
  diagnosticPath?: string;
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
  /** §20 完成时补录的 HTTP 状态码与诊断路径。 */
  httpStatus?: number;
  diagnosticPath?: string;
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

/** 显式列清单：固定 AttemptRow 契约，schema 改名/删列时在 prepare 期即报错。 */
const ATTEMPT_COLUMNS = `id, migration_job_id, attempt_scope, source_item_id, target_artifact_id,
                stage, action_code, attempt_no, candidate_quality, candidate_degradations_json,
                candidate_source_content_hash, overwrite_policy, expected_written_file_hash,
                observed_prewrite_file_hash, result_written_file_hash, audit_metadata_json,
                started_at, finished_at, success, error_code, error_message, http_status,
                diagnostic_path, created_at`;

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
        `INSERT INTO migration_attempts(migration_job_id,attempt_scope,source_item_id,target_artifact_id,stage,action_code,attempt_no,candidate_quality,candidate_degradations_json,candidate_source_content_hash,overwrite_policy,audit_metadata_json,http_status,diagnostic_path,started_at,created_at)
         VALUES(@migrationJobId,'item',@sourceItemId,@targetArtifactId,@stage,@actionCode,@attemptNo,@candidateQuality,@candidateDegradationsJson,@candidateSourceContentHash,@overwritePolicy,@auditMetadataJson,@httpStatus,@diagnosticPath,@startedAt,@createdAt)`,
      )
      .run({
        ...i,
        // 逐字段 ?? 归一：显式传入的 undefined（可选属性合法）不能覆盖默认值，
        // 否则 better-sqlite3 拒绝 undefined 绑定值而在运行期抛错。
        targetArtifactId: i.targetArtifactId ?? null,
        candidateQuality: i.candidateQuality ?? null,
        candidateDegradationsJson: i.candidateDegradationsJson ?? null,
        candidateSourceContentHash: i.candidateSourceContentHash ?? null,
        overwritePolicy: i.overwritePolicy ?? null,
        auditMetadataJson: i.auditMetadataJson ?? '{}',
        httpStatus: i.httpStatus ?? null,
        diagnosticPath: i.diagnosticPath ?? null,
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
        `SELECT ${ATTEMPT_COLUMNS}
         FROM migration_attempts
         WHERE migration_job_id=? AND source_item_id=? ORDER BY id`,
      )
      .all(migrationJobId, sourceItemId) as AttemptRow[];
  }

  /**
   * R3-H1: 查询某 item 在某 job 下已有的最大 attempt_no（用于 resume 时递增）。
   * 返回 0 表示无历史尝试。
   */
  maxAttemptNo(migrationJobId: string, sourceItemId: number): number {
    const row = this.db
      .prepare(
        `SELECT MAX(attempt_no) AS m FROM migration_attempts
         WHERE migration_job_id=? AND source_item_id=?`,
      )
      .get(migrationJobId, sourceItemId) as { m: number | null } | undefined;
    return row?.m ?? 0;
  }

  listByJob(migrationJobId: string): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM migration_attempts WHERE migration_job_id=? ORDER BY id`,
      )
      .all(migrationJobId) as AttemptRow[];
  }

  /** 关闭一条尝试：写入 success/finishedAt 与可选错误信息或覆盖哈希。
   *  id 不存在（或已被级联删除）时抛错，避免审计行停留在未关闭状态而无任何信号。 */
  finishAttempt(id: number, f: FinishAttemptInput): void {
    const result = this.db
      .prepare(
        `UPDATE migration_attempts
         SET success=@success,
             finished_at=@finishedAt,
             error_code=COALESCE(@errorCode, error_code),
             error_message=COALESCE(@errorMessage, error_message),
             expected_written_file_hash=COALESCE(@expectedWrittenFileHash, expected_written_file_hash),
             observed_prewrite_file_hash=COALESCE(@observedPrewriteFileHash, observed_prewrite_file_hash),
             result_written_file_hash=COALESCE(@resultWrittenFileHash, result_written_file_hash),
             http_status=COALESCE(@httpStatus, http_status),
             diagnostic_path=COALESCE(@diagnosticPath, diagnostic_path)
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
        httpStatus: f.httpStatus ?? null,
        diagnosticPath: f.diagnosticPath ?? null,
      });
    if (result.changes === 0) {
      throw new Error(`finishAttempt: migration_attempts id=${id} 不存在，尝试未被关闭`);
    }
  }
}
