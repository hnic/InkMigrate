import type { DB } from '../database.js';

export interface SourceItemInput {
  sourceInstanceId: string;
  externalId?: string;
  fingerprint: string;
  stableKey: string;
  itemKey: string;
  stableShortId: string;
  canonicalUrl?: string;
  originalUrl?: string;
  title?: string;
  contentKind: string;
  sourcePosition?: number;
  discoveredAt: string;
  status: string;
  quality?: string;
  degradationsJson?: string;
  sourceContentHash?: string;
  sourceMetadataJson?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceItemRow {
  id: number;
  sourceInstanceId: string;
  externalId?: string;
  fingerprint: string;
  stableKey: string;
  itemKey: string;
  stableShortId: string;
  canonicalUrl?: string;
  originalUrl?: string;
  title?: string;
  contentKind: string;
  sourcePosition?: number;
  discoveredAt: string;
  status: string;
  quality?: string;
  degradationsJson: string;
  sourceContentHash?: string;
  sourceMetadataJson: string;
}

export interface UpdateCommittedResultInput {
  status: string;
  quality?: string;
  degradationsJson?: string;
  sourceContentHash?: string;
  updatedAt: string;
}

/**
 * §16.4 source_items 仓储。
 *
 * `quality`、`degradations_json`、`source_content_hash` 在仅扫描阶段可以为空，
 * 只有目标验证成功后才提交到本表；当前迁移尝试的候选值由 MigrationAttempts 保存。
 */
export class SourceItems {
  constructor(private db: DB) {}

  create(i: SourceItemInput): void {
    this.db
      .prepare(
        `INSERT INTO source_items(source_instance_id,external_id,fingerprint,stable_key,item_key,stable_short_id,canonical_url,original_url,title,content_kind,source_position,discovered_at,status,quality,degradations_json,source_content_hash,source_metadata_json,created_at,updated_at)
         VALUES(@sourceInstanceId,@externalId,@fingerprint,@stableKey,@itemKey,@stableShortId,@canonicalUrl,@originalUrl,@title,@contentKind,@sourcePosition,@discoveredAt,@status,@quality,@degradationsJson,@sourceContentHash,@sourceMetadataJson,@createdAt,@updatedAt)`,
      )
      .run({
        externalId: null,
        canonicalUrl: null,
        originalUrl: null,
        title: null,
        sourcePosition: null,
        quality: null,
        degradationsJson: '[]',
        sourceContentHash: null,
        sourceMetadataJson: '{}',
        ...i,
      });
  }

  findByFingerprint(
    sourceInstanceId: string,
    fingerprint: string,
  ): SourceItemRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_instance_id AS sourceInstanceId, external_id AS externalId,
                fingerprint, stable_key AS stableKey, item_key AS itemKey,
                stable_short_id AS stableShortId, canonical_url AS canonicalUrl,
                original_url AS originalUrl, title, content_kind AS contentKind,
                source_position AS sourcePosition, discovered_at AS discoveredAt,
                status, quality, degradations_json AS degradationsJson,
                source_content_hash AS sourceContentHash,
                source_metadata_json AS sourceMetadataJson
         FROM source_items
         WHERE source_instance_id=? AND fingerprint=?`,
      )
      .get(sourceInstanceId, fingerprint) as SourceItemRow | undefined;
  }

  /**
   * §11.5 / §16.4 在目标写入和验证成功后，把候选 quality/degradations/hash
   * 提交为本表的最新已验证结果。
   */
  updateCommittedResult(id: number, u: UpdateCommittedResultInput): void {
    this.db
      .prepare(
        `UPDATE source_items
         SET status=@status,
             quality=COALESCE(@quality, quality),
             degradations_json=COALESCE(@degradationsJson, degradations_json),
             source_content_hash=COALESCE(@sourceContentHash, source_content_hash),
             updated_at=@updatedAt
         WHERE id=@id`,
      )
      .run({
        id,
        status: u.status,
        quality: u.quality ?? null,
        degradationsJson: u.degradationsJson ?? null,
        sourceContentHash: u.sourceContentHash ?? null,
        updatedAt: u.updatedAt,
      });
  }
}
