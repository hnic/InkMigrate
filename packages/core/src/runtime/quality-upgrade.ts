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
  // §8.5 不变式：quality=full 必须零 degradations（validateSourceItemQuality
  // 对违反者抛错），本分支仅在输入违反该契约时触发。调用方（job-runner）直接
  // 传 adapter 边界产出（sourceAdapter.extract() 的 item.degradations）、未先跑
  // 校验，故防御性读取：列表缺失按空处理（与 §8.5「full 意味着无降级」一致），
  // 不让畸形 adapter 结果以 TypeError 击穿条目迁移。
  if ((i.newDegradations?.length ?? 0) > 0) return false;
  return true;
}
