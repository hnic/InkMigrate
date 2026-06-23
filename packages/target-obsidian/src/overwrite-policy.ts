import type { ArtifactKind } from '@inkmigrate/core';
import type { ObsidianTargetConfig } from './config.js';

export type OverwriteAction =
  | 'write_canonical'
  | 'forced_overwrite'
  | 'write_new_variant'
  | 'update_metadata_only'
  | 'mark_conflict';

export interface OverwriteDecision {
  action: OverwriteAction;
  artifactKind: ArtifactKind;
  /** §13.9 是否需要 forced_overwrite 审计。 */
  requiresForcedOverwriteAudit: boolean;
  /** §13.9 覆盖前观察到的磁盘哈希（若 targetExists 且调用方传入）。 */
  observedPrewriteFileHash?: string;
  /** §13.9 数据库记录的期望哈希（若调用方传入）。 */
  expectedWrittenFileHash?: string;
}

export interface DecideInput {
  config: ObsidianTargetConfig;
  targetExists: boolean;
  userModified: boolean;
  isMetadataOnlyUpdate: boolean;
  observedPrewriteFileHash?: string;
  expectedWrittenFileHash?: string;
}

/**
 * §13.9 覆盖策略决策树。
 *
 * 表中"目标未被用户修改"是所有策略共享的安全更新路径；`write-new` 只在检测到
 * 用户或外部修改时与 `preserve` 分化。
 *
 * - 目标不存在 → 一律 `write_canonical`（首次写入）。
 * - 目标存在、未修改 → `preserve`/`replace`/`write-new` 走 `write_canonical` 原子更新；
 *   `metadata-only` 走 `update_metadata_only`。
 * - 目标存在、已修改 → `preserve`/`metadata-only` 走 `mark_conflict`；
 *   `replace` 走 `forced_overwrite`（需审计）；`write-new` 走 `write_new_variant`。
 */
export function decideOverwrite(i: DecideInput): OverwriteDecision {
  // 首次写入
  if (!i.targetExists) {
    return {
      action: 'write_canonical',
      artifactKind: 'note',
      requiresForcedOverwriteAudit: false,
    };
  }

  // 目标未修改：所有策略走安全更新路径
  if (!i.userModified) {
    if (i.config.overwritePolicy === 'metadata-only' || i.isMetadataOnlyUpdate) {
      return {
        action: 'update_metadata_only',
        artifactKind: 'note',
        requiresForcedOverwriteAudit: false,
      };
    }
    // preserve / replace / write-new 在未修改时行为相同：原路径原子更新
    return {
      action: 'write_canonical',
      artifactKind: 'note',
      requiresForcedOverwriteAudit: false,
    };
  }

  // 目标已修改
  switch (i.config.overwritePolicy) {
    case 'preserve':
      return {
        action: 'mark_conflict',
        artifactKind: 'note',
        requiresForcedOverwriteAudit: false,
      };
    case 'replace': {
      const d: OverwriteDecision = {
        action: 'forced_overwrite',
        artifactKind: 'note',
        requiresForcedOverwriteAudit: true,
      };
      if (i.observedPrewriteFileHash !== undefined) {
        d.observedPrewriteFileHash = i.observedPrewriteFileHash;
      }
      if (i.expectedWrittenFileHash !== undefined) {
        d.expectedWrittenFileHash = i.expectedWrittenFileHash;
      }
      return d;
    }
    case 'write-new': {
      const d: OverwriteDecision = {
        action: 'write_new_variant',
        artifactKind: 'note_variant',
        requiresForcedOverwriteAudit: false,
      };
      if (i.observedPrewriteFileHash !== undefined) {
        d.observedPrewriteFileHash = i.observedPrewriteFileHash;
      }
      return d;
    }
    case 'metadata-only':
      // 用户修改后，metadata-only 无法安全做正文升级 → 冲突
      return {
        action: 'mark_conflict',
        artifactKind: 'note',
        requiresForcedOverwriteAudit: false,
      };
  }
}
