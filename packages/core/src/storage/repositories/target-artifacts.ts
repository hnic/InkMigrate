import type { DB } from '../database.js';

export interface TargetArtifactInput {
  migrationJobId: string;
  sourceItemId?: number;
  artifactKind: string;
  targetInstanceId: string;
  relativePath: string;
  targetContentHash?: string;
  writtenFileHash?: string;
  status: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TargetArtifactRow {
  id: number;
  migrationJobId: string;
  sourceItemId?: number;
  artifactKind: string;
  targetInstanceId: string;
  relativePath: string;
  targetContentHash?: string;
  writtenFileHash?: string;
  status: string;
  verifiedAt?: string;
}

/** §16.6 target_artifacts 仓储。 */
export class TargetArtifacts {
  constructor(private db: DB) {}

  create(i: TargetArtifactInput): void {
    this.db
      .prepare(
        `INSERT INTO target_artifacts(migration_job_id,source_item_id,artifact_kind,target_instance_id,relative_path,target_content_hash,written_file_hash,status,verified_at,created_at,updated_at)
         VALUES(@migrationJobId,@sourceItemId,@artifactKind,@targetInstanceId,@relativePath,@targetContentHash,@writtenFileHash,@status,@verifiedAt,@createdAt,@updatedAt)`,
      )
      .run({
        sourceItemId: null,
        targetContentHash: null,
        writtenFileHash: null,
        verifiedAt: null,
        ...i,
      });
  }

  listByJob(migrationJobId: string): TargetArtifactRow[] {
    return this.db
      .prepare(
        `SELECT id, migration_job_id AS migrationJobId, source_item_id AS sourceItemId,
                artifact_kind AS artifactKind, target_instance_id AS targetInstanceId,
                relative_path AS relativePath, target_content_hash AS targetContentHash,
                written_file_hash AS writtenFileHash, status, verified_at AS verifiedAt
         FROM target_artifacts WHERE migration_job_id=? ORDER BY id`,
      )
      .all(migrationJobId) as TargetArtifactRow[];
  }

  /** §13.9 查找 source_item 对应的最近一条 verified artifact（用于 conflict 检测）。 */
  findBySourceItem(sourceItemId: number): TargetArtifactRow | undefined {
    return this.db
      .prepare(
        `SELECT id, migration_job_id AS migrationJobId, source_item_id AS sourceItemId,
                artifact_kind AS artifactKind, target_instance_id AS targetInstanceId,
                relative_path AS relativePath, target_content_hash AS targetContentHash,
                written_file_hash AS writtenFileHash, status, verified_at AS verifiedAt
         FROM target_artifacts
         WHERE source_item_id=? AND status='verified'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sourceItemId) as TargetArtifactRow | undefined;
  }

  /**
   * 按 (target_instance_id, relative_path) 精确查找（走表级 UNIQUE 约束对应的索引）。
   *
   * UNIQUE(target_instance_id, relative_path) 是跨 Job 约束：同一目标实例下同一路径
   * 全局只能有一条 artifact。重跑/续跑/跨 Job 重处理同一文章时，artifact 可能已存在
   *（上一轮已写入）。commitTxn 用此方法在 create 前探测，命中即 UPDATE 而非 INSERT，
   * 避免 UNIQUE constraint failed。属同一 source_item 的命中视为合法重处理（升级/续跑），
   * 属不同 source_item 的命中才是真冲突（由调用方决定 conflict 处置）。
   */
  findByTargetPath(
    targetInstanceId: string,
    relativePath: string,
  ): TargetArtifactRow | undefined {
    return this.db
      .prepare(
        `SELECT id, migration_job_id AS migrationJobId, source_item_id AS sourceItemId,
                artifact_kind AS artifactKind, target_instance_id AS targetInstanceId,
                relative_path AS relativePath, target_content_hash AS targetContentHash,
                written_file_hash AS writtenFileHash, status, verified_at AS verifiedAt
         FROM target_artifacts
         WHERE target_instance_id=? AND relative_path=?`,
      )
      .get(targetInstanceId, relativePath) as TargetArtifactRow | undefined;
  }

  /** 更新已有 artifact 的可变列（用于重跑/续跑时刷新同一路径的记录）。 */
  updateCommitted(id: number, u: {
    migrationJobId?: string;
    sourceItemId?: number;
    targetContentHash?: string;
    writtenFileHash?: string;
    status?: string;
    verifiedAt?: string;
    updatedAt: string;
  }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      migrationJobId: 'migration_job_id',
      sourceItemId: 'source_item_id',
      targetContentHash: 'target_content_hash',
      writtenFileHash: 'written_file_hash',
      status: 'status',
      verifiedAt: 'verified_at',
      updatedAt: 'updated_at',
    };
    for (const [k, v] of Object.entries(u)) {
      if (v === undefined) continue;
      sets.push(`${map[k]} = @${k}`);
      params[k] = v;
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE target_artifacts SET ${sets.join(', ')} WHERE id=@id`)
      .run(params);
  }

  /**
   * §13.8 索引生成：列出某 Job 某 source 实例下所有 verified 笔记 artifact，
   * 连接 source_items 取标题/内容类型/收藏集合等元数据，供 renderIndex 构造分片索引。
   * 仅返回 artifact_kind='note' 且 status='verified' 的条目。
   */
  listVerifiedNotesForIndex(
    migrationJobId: string,
    sourceInstanceId: string,
  ): {
    relativePath: string;
    title: string | null;
    contentKind: string;
    sourceMetadataJson: string;
  }[] {
    return this.db
      .prepare(
        `SELECT ta.relative_path AS relativePath,
                si.title AS title,
                si.content_kind AS contentKind,
                si.source_metadata_json AS sourceMetadataJson
         FROM target_artifacts ta
         JOIN source_items si ON si.id = ta.source_item_id
         WHERE ta.migration_job_id = ?
           AND ta.artifact_kind = 'note'
           AND ta.status = 'verified'
           AND si.source_instance_id = ?
         ORDER BY ta.id`,
      )
      .all(migrationJobId, sourceInstanceId) as {
      relativePath: string;
      title: string | null;
      contentKind: string;
      sourceMetadataJson: string;
    }[];
  }

  /** §13.8 列出某 Job 下所有 index artifact（relativePath + 哈希），用于索引重跑保护。 */
  listIndexArtifacts(
    migrationJobId: string,
  ): { relativePath: string; writtenFileHash: string | undefined }[] {
    return this.db
      .prepare(
        `SELECT relative_path AS relativePath, written_file_hash AS writtenFileHash
         FROM target_artifacts
         WHERE migration_job_id = ? AND artifact_kind = 'index'`,
      )
      .all(migrationJobId) as {
      relativePath: string;
      writtenFileHash: string | undefined;
    }[];
  }
}
