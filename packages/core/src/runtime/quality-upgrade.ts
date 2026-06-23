import type {
  SourceItemQuality,
  SourceDegradation,
} from '../domain/models.js';

export interface UpgradeCheckInput {
  /** 上一次已提交的质量。undefined 表示首次迁移（不是升级）。 */
  previousQuality?: SourceItemQuality;
  newQuality: SourceItemQuality;
  newDegradations: readonly SourceDegradation[];
}

/**
 * §17.5 判断本次重新提取是否构成 `degraded → full` 质量升级候选。
 *
 * 条件：previousQuality === 'degraded' && newQuality === 'full' && degradations 为空。
 * 升级候选不立即修改状态；Job 必须完整执行目标重写+验证后才提交（§17.5）。
 */
export function isQualityUpgradeCandidate(i: UpgradeCheckInput): boolean {
  if (i.previousQuality !== 'degraded') return false;
  if (i.newQuality !== 'full') return false;
  if (i.newDegradations.length > 0) return false;
  return true;
}
