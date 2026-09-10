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

/** 可空列声明为 `| null` 而非可选属性：better-sqlite3 将 SQL NULL 映射为 JS null
 *（绝非 undefined），类型与运行时一致可避免 `=== undefined` 形式的守卫静默失效。 */
export interface SourceItemRow {
  id: number;
  sourceInstanceId: string;
  externalId: string | null;
  fingerprint: string;
  stableKey: string;
  itemKey: string;
  stableShortId: string;
  canonicalUrl: string | null;
  originalUrl: string | null;
  title: string | null;
  contentKind: string;
  sourcePosition: number | null;
  discoveredAt: string;
  status: string;
  quality: string | null;
  degradationsJson: string;
  sourceContentHash: string | null;
  sourceMetadataJson: string;
}

export interface UpdateCommittedResultInput {
  status: string;
  /** 可选字段传 undefined/null 表示保留库中原值（COALESCE 语义）——因此无法把
   *  quality/source_content_hash 显式清回 NULL；degradations_json 非 NULL，清空
   *  目标值为 '[]'，不受此限制。status 恒为无条件覆盖。 */
  quality?: string;
  degradationsJson?: string;
  sourceContentHash?: string;
  updatedAt: string;
}

/** 列清单常量：findByFingerprint 与 findByExternalId 共用，避免两份 SELECT 漂移。 */
const SOURCE_ITEM_COLUMNS = `id, source_instance_id AS sourceInstanceId, external_id AS externalId,
                fingerprint, stable_key AS stableKey, item_key AS itemKey,
                stable_short_id AS stableShortId, canonical_url AS canonicalUrl,
                original_url AS originalUrl, title, content_kind AS contentKind,
                source_position AS sourcePosition, discovered_at AS discoveredAt,
                status, quality, degradations_json AS degradationsJson,
                source_content_hash AS sourceContentHash,
                source_metadata_json AS sourceMetadataJson`;

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
        ...i,
        // 逐字段 ?? 归一：显式传入的 undefined（可选属性合法，如源侧 title 缺失）
        // 不能覆盖默认值，否则 better-sqlite3 拒绝 undefined 绑定值而在运行期抛错。
        externalId: i.externalId ?? null,
        canonicalUrl: i.canonicalUrl ?? null,
        originalUrl: i.originalUrl ?? null,
        title: i.title ?? null,
        sourcePosition: i.sourcePosition ?? null,
        quality: i.quality ?? null,
        degradationsJson: i.degradationsJson ?? '[]',
        sourceContentHash: i.sourceContentHash ?? null,
        sourceMetadataJson: i.sourceMetadataJson ?? '{}',
      });
  }

  findByFingerprint(
    sourceInstanceId: string,
    fingerprint: string,
  ): SourceItemRow | undefined {
    return this.db
      .prepare(
        `SELECT ${SOURCE_ITEM_COLUMNS}
         FROM source_items
         WHERE source_instance_id=? AND fingerprint=?`,
      )
      .get(sourceInstanceId, fingerprint) as SourceItemRow | undefined;
  }

  /**
   * 按 external_id 查询（走 uq_source_items_ext 部分唯一索引）。
   *
   * 用于 persistSourceItemRef 的幂等兜底：DB 有 UNIQUE(source_instance_id, external_id)
   * 约束，但 fingerprint 算法变更或同文章不同 URL（相同数字 ID 不同 canonicalUrl）时，
   * 两条 ref 的 fingerprint 可能不同——仅按 fingerprint 查重会放过第二条，随后被
   * external_id 唯一约束拒绝（UNIQUE constraint failed）。命中 external_id 即视为
   * 已扫描，跳过插入，保持幂等。
   */
  findByExternalId(
    sourceInstanceId: string,
    externalId: string,
  ): SourceItemRow | undefined {
    return this.db
      .prepare(
        `SELECT ${SOURCE_ITEM_COLUMNS}
         FROM source_items
         WHERE source_instance_id=? AND external_id=?`,
      )
      .get(sourceInstanceId, externalId) as SourceItemRow | undefined;
  }

  /**
   * §11.5 / §16.4 在目标写入和验证成功后，把候选 quality/degradations/hash
   * 提交为本表的最新已验证结果。行不存在时抛错，避免调用方误以为结果已落库。
   */
  updateCommittedResult(id: number, u: UpdateCommittedResultInput): void {
    const result = this.db
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
    if (result.changes === 0) {
      throw new Error(`source_items 行不存在：id=${id}，提交结果未落库`);
    }
  }
}
