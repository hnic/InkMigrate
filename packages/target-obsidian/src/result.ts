import type { ArtifactKind } from '@inkmigrate/core';

/**
 * §13.9 / §17.5 目标适配器返回的写入结果（在 stage 1 `TargetWriteResult` 之上扩展）。
 *
 * 阶段 2 target 适配器返回这个扩展类型；阶段 4 Job 编排层据此写 `migration_attempts`
 * 的 `forced_overwrite` / `write_new_variant` / `metadata_update` 审计记录
 * （§13.9 选项 A：target 不直接写 DB）。
 */
export interface ObsidianWriteResult {
  relativePath: string;
  artifactKind: ArtifactKind;
  /** §13.9 渲染后逻辑内容哈希。 */
  targetContentHash: string;
  /** §13.9 磁盘精确字节哈希。 */
  writtenFileHash: string;
  /** §13.9 来源标准化内容哈希（来自 SourceItem，回写便于审计）。 */
  sourceContentHash: string;
  /** 本次写入是否覆盖了用户已修改的文件（仅 `forced_overwrite` 时为 true）。 */
  wasForcedOverwrite: boolean;
  /** 覆盖前的磁盘哈希（仅 `forced_overwrite` 时有值）。 */
  observedPrewriteFileHash?: string;
  /** 覆盖前数据库记录的期望哈希（仅 `forced_overwrite` 时有值）。 */
  expectedWrittenFileHash?: string;
  /** §13.9 实际生效的覆盖策略。 */
  overwritePolicy: 'preserve' | 'replace' | 'write-new' | 'metadata-only';
  /** §17.5 action_code，由决策树决定；阶段 4 写 migration_attempts 时使用。 */
  actionCode:
    | 'stage_attempt'
    | 'source_update'
    | 'quality_upgrade'
    | 'forced_overwrite'
    | 'write_new_variant'
    | 'metadata_update';
}
