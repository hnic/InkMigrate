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

/** 列清单常量：所有返回整行的查询共用，避免多份 SELECT 投影漂移。 */
const TARGET_ARTIFACT_COLUMNS = `id, migration_job_id AS migrationJobId, source_item_id AS sourceItemId,
                artifact_kind AS artifactKind, target_instance_id AS targetInstanceId,
                relative_path AS relativePath, target_content_hash AS targetContentHash,
                written_file_hash AS writtenFileHash, status, verified_at AS verifiedAt`;

/** 业务字面量常量：与 create() 调用方传入的 status/artifactKind 保持同词表，
 *  避免两侧拼写漂移导致查询静默返回空集（同 TARGET_ARTIFACT_COLUMNS 的动机）。 */
const STATUS_VERIFIED = 'verified';
const ARTIFACT_KIND_NOTE = 'note';
const ARTIFACT_KIND_INDEX = 'index';

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
        ...i,
        // 逐字段 ?? 归一：显式传入的 undefined（可选属性合法，如 index artifact 的
        // targetContentHash/writtenFileHash 可能缺省）不能覆盖 NULL 默认值，
        // 否则 better-sqlite3 拒绝 undefined 绑定值而在运行期抛错。
        sourceItemId: i.sourceItemId ?? null,
        targetContentHash: i.targetContentHash ?? null,
        writtenFileHash: i.writtenFileHash ?? null,
        verifiedAt: i.verifiedAt ?? null,
      });
  }

  listByJob(migrationJobId: string): TargetArtifactRow[] {
    return this.db
      .prepare(
        `SELECT ${TARGET_ARTIFACT_COLUMNS}
         FROM target_artifacts WHERE migration_job_id=? ORDER BY id`,
      )
      .all(migrationJobId) as TargetArtifactRow[];
  }

  /** §13.9 查找 source_item 对应的最近一条 verified artifact（用于 conflict 检测）。 */
  findBySourceItem(sourceItemId: number): TargetArtifactRow | undefined {
    return this.db
      .prepare(
        `SELECT ${TARGET_ARTIFACT_COLUMNS}
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
        `SELECT ${TARGET_ARTIFACT_COLUMNS}
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
      // 白名单守卫：未知键拼进 SET 会生成 `undefined = @x` 这类难解的语法错误
      const column = map[k];
      if (column === undefined) {
        throw new Error(`updateCommitted: 未知字段 "${k}"（id=${id}）`);
      }
      sets.push(`${column} = @${k}`);
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
   *
   * INNER JOIN 的前置不变量：note artifact 创建时必带 source_item_id（job-runner
   * 仅对 index 类留空），且 source_items 无删除路径——source_item 缺失/为 NULL 的
   * note 只可能来自库外手工操作。此类行缺少索引所需的 title/contentKind 元数据，
   * 排除是预期行为（如未来引入 source_items 删除，需在此复核并显式处理分叉）。
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
           AND ta.artifact_kind = '${ARTIFACT_KIND_NOTE}'
           AND ta.status = '${STATUS_VERIFIED}'
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

  /**
   * R4-M9: 列出某 target_instance 下所有 index artifact（跨 job），用于索引重跑保护。
   * 原按 migration_job_id 查询 → 新 job 的 listIndexArtifacts 返回空 →
   * 用户编辑的索引文件被静默覆盖。改为按 target_instance_id 查询。
   *（R6: writtenFileHash 为 SQL NULL 时 better-sqlite3 返回 null 而非 undefined，
   *  下游需用 != null 过滤；按 job 查询的旧变体已删除，统一走本方法。）
   */
  listIndexArtifactsByTarget(
    targetInstanceId: string,
  ): { relativePath: string; writtenFileHash: string | null }[] {
    return this.db
      .prepare(
        `SELECT relative_path AS relativePath, written_file_hash AS writtenFileHash
         FROM target_artifacts
         WHERE target_instance_id = ? AND artifact_kind = '${ARTIFACT_KIND_INDEX}'`,
      )
      .all(targetInstanceId) as {
      relativePath: string;
      writtenFileHash: string | null;
    }[];
  }
}
