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
