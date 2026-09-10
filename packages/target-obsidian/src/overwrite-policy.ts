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
  /**
   * §13.9 覆盖前观察到的磁盘哈希（若 targetExists 且调用方传入）。
   * 仅 replace/write-new 破坏性分支携带（copyAuditHashes）；mark_conflict /
   * update_metadata_only 路径不携带——冲突记录所需的 prewrite 哈希由调用方
   * （writeNote）自行观测并落库，见 adapter 的 mark_conflict 分支。
   */
  observedPrewriteFileHash?: string;
  /** §13.9 数据库记录的期望哈希（若调用方传入；仅 replace/write-new 分支携带）。 */
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
 * - 目标存在、未修改 → `metadata-only` 策略、或计划本身只涉及元数据变更
 *   （`isMetadataOnlyUpdate`，无论配置何种策略——对未修改目标刷新元数据总是
 *   安全的）走 `update_metadata_only`；其余 `preserve`/`replace`/`write-new`
 *   走 `write_canonical` 原子更新。
 * - 目标存在、已修改 → `preserve`/`metadata-only` 走 `mark_conflict`；
 *   `replace` 走 `forced_overwrite`（需审计）；`write-new` 走 `write_new_variant`。
 *
 * 注意：本决策树仅服务于笔记类 artifact——附件走 writeAsset 内容寻址路径，
 * 不经过这里，故 artifactKind 固定为 'note' / 'note_variant'。
 */
export function decideOverwrite(i: DecideInput): OverwriteDecision {
  // 入口统一校验：未知策略在【所有】分支快速失败。下方 switch 的 default 穷尽性
  // 守卫只覆盖 userModified 路径——targetExists 且未修改的分支会无条件落
  // write_canonical，垃圾策略串（跳过 schema parse 的原始 config，如 'preservee'）
  // 恰在此静默覆写用户文件，违背守卫"快速失败"的初衷，故校验必须前置到入口。
  if (
    i.config.overwritePolicy !== 'preserve' &&
    i.config.overwritePolicy !== 'replace' &&
    i.config.overwritePolicy !== 'write-new' &&
    i.config.overwritePolicy !== 'metadata-only'
  ) {
    throw new Error(
      `decideOverwrite: unknown overwritePolicy: ${String(i.config.overwritePolicy)}`,
    );
  }

  // 双哈希齐备时以实测为准，不信任调用方可能过期的 userModified 标志：
  // 未来调用方误传标志会把用户改过的文件路由进 write_canonical（数据丢失），
  // 或把未修改文件误挂 mark_conflict；本层既然拿到了推导该标志的原始数据，
  // 就在入口交叉复核。仅单个哈希（§缺陷1 的 expected 缺失路径）时保留调用方判定。
  if (
    i.observedPrewriteFileHash !== undefined &&
    i.expectedWrittenFileHash !== undefined
  ) {
    i = {
      ...i,
      userModified: i.observedPrewriteFileHash !== i.expectedWrittenFileHash,
    };
  }

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
      copyAuditHashes(d, i);
      return d;
    }
    case 'write-new': {
      const d: OverwriteDecision = {
        action: 'write_new_variant',
        artifactKind: 'note_variant',
        requiresForcedOverwriteAudit: false,
      };
      copyAuditHashes(d, i);
      return d;
    }
    case 'metadata-only':
      // 用户修改后，metadata-only 无法安全做正文升级 → 冲突
      return {
        action: 'mark_conflict',
        artifactKind: 'note',
        requiresForcedOverwriteAudit: false,
      };
    default: {
      // 穷尽性守卫：DecideInput 接受未经 schema parse 的原始 config 对象，
      // 运行时传入未知策略时在此快速失败，而不是隐式返回 undefined
      // 破坏 OverwriteDecision 的非空返回契约（新增枚举值时 TS 也会在此报错）。
      const policy: never = i.config.overwritePolicy;
      throw new Error(
        `decideOverwrite: unknown overwritePolicy: ${String(policy)}`,
      );
    }
  }
}

/** 与 replace/write-new 分支共用：对称携带审计哈希（若调用方传入）。 */
function copyAuditHashes(d: OverwriteDecision, i: DecideInput): void {
  if (i.observedPrewriteFileHash !== undefined) {
    d.observedPrewriteFileHash = i.observedPrewriteFileHash;
  }
  if (i.expectedWrittenFileHash !== undefined) {
    d.expectedWrittenFileHash = i.expectedWrittenFileHash;
  }
}
