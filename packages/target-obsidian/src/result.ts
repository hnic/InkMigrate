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
  /**
   * H-1: mark_conflict 时为 true——表示未写入文件（保留用户已有内容）。
   * job-runner 据此跳过 verify（verify 不写文件会误判 ok=true，把冲突吞为 verified）。
   */
  skippedWrite?: boolean;
  /**
   * §17.5 action_code，由决策树决定；阶段 4 写 migration_attempts 时使用。
   *
   * L20: 当前 writeNote 仅产出 'stage_attempt' / 'forced_overwrite' /
   * 'write_new_variant'。'source_update' / 'quality_upgrade' / 'metadata_update'
   * 为前向兼容保留（对应未实现的 metadata-only 全路径与质量升级全流程，见 L21），
   * 当前不可达，但保留在联合类型中以稳定 DB action_code 契约。
   */
  actionCode:
    | 'stage_attempt'
    | 'source_update'
    | 'quality_upgrade'
    | 'forced_overwrite'
    | 'write_new_variant'
    | 'metadata_update';
}
