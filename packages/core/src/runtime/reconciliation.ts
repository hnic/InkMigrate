import type { ItemFinalState, ItemRecoverableState, FinalStateCounts } from '../domain/states.js';
import {
  aggregateFailedCount,
  isItemFinalState,
  ITEM_RECOVERABLE_STATES,
} from '../domain/states.js';

/** §11.9 从条目终态列表派生明细计数。可恢复态（interrupted/retryable_failed）不计入。 */
export function deriveFinalStateCounts(
  states: readonly (ItemFinalState | ItemRecoverableState | string)[],
): FinalStateCounts {
  const counts: FinalStateCounts = {
    verified: 0,
    degraded: 0,
    permanent_failed: 0,
    unsupported: 0,
    blocked: 0,
    conflict: 0,
    skipped: 0,
  };
  for (const s of states) {
    // 仅统计 domain 声明的完成终态（委托 isItemFinalState，未知状态确定性跳过）。
    // 不用 `s in counts`：它会命中原型链上的 'toString' 等继承键，自增得到 NaN，
    // 既漏计条目又污染返回的计数对象。
    if (isItemFinalState(s)) {
      counts[s]++;
    }
  }
  return counts;
}

export interface CachedJobCounts {
  verified_count: number;
  degraded_count: number;
  failed_count: number;
  conflict_count: number;
  skipped_count: number;
}

export interface ReconcileInput {
  scanCount: number;
  /** 条目状态列表（完成终态 + 可恢复态；可恢复态不计入等式，仅 recoverableCount 用）。 */
  itemStates: readonly (ItemFinalState | ItemRecoverableState)[];
  recoverableCount: number;
  cachedCounts: CachedJobCounts;
}

export interface ReconciliationResult {
  ok: boolean;
  reason?: string;
  derived?: FinalStateCounts;
}

/**
 * §11.9 完整性方程对账。
 *
 * Job 进入 completed 前必须满足：
 * 1. recoverable_count == 0
 * 2. scan_count == verified + degraded + failed + conflict + skipped
 * 3. 派生 failed_count == migration_jobs.failed_count 缓存
 * 4. 其它缓存列与派生一致
 */
export function reconcileJob(i: ReconcileInput): ReconciliationResult {
  // 交叉校验 recoverableCount 与 itemStates 中实际存在的可恢复态：两者来自不同
  // 统计路径，若失同步（itemStates 尚有悬挂条目而 recoverableCount 报 0），下方
  // 等式检查只会给出误导性的失败原因，甚至放过带悬挂条目的完成。先给出可诊断的
  // 独立失败原因。
  const recoverableInStates = i.itemStates.filter((s) =>
    (ITEM_RECOVERABLE_STATES as readonly string[]).includes(s),
  ).length;
  if (i.recoverableCount !== recoverableInStates) {
    return {
      ok: false,
      reason: `recoverable_count desync: input=${i.recoverableCount} but itemStates contains ${recoverableInStates} recoverable items`,
    };
  }
  if (i.recoverableCount > 0) {
    return {
      ok: false,
      reason: `integrity check failed: ${i.recoverableCount} recoverable items still hanging`,
    };
  }

  const derived = deriveFinalStateCounts(i.itemStates);
  const derivedFailed = aggregateFailedCount(derived);

  // §11.9 完整性方程按七个终态显式求和，与 domain/verifyCompletionEquation 同口径；
  // 不借道 aggregateFailedCount——它与等式相符依赖「failed 聚合恰好包含
  // permanent_failed + unsupported + blocked」这一聚合口径，口径一变等式就会
  // 无提示地断裂。derivedFailed 仅用于下方与缓存列 failed_count 的对比。
  const sum =
    derived.verified +
    derived.degraded +
    derived.permanent_failed +
    derived.unsupported +
    derived.blocked +
    derived.conflict +
    derived.skipped;
  if (sum !== i.scanCount) {
    return {
      ok: false,
      reason: `integrity equation failed: scan_count=${i.scanCount} but sum of final states=${sum}`,
      derived,
    };
  }

  if (derivedFailed !== i.cachedCounts.failed_count) {
    return {
      ok: false,
      reason: `failed_count mismatch: derived=${derivedFailed} but cached=${i.cachedCounts.failed_count}`,
      derived,
    };
  }

  if (
    derived.verified !== i.cachedCounts.verified_count ||
    derived.degraded !== i.cachedCounts.degraded_count ||
    derived.conflict !== i.cachedCounts.conflict_count ||
    derived.skipped !== i.cachedCounts.skipped_count
  ) {
    return {
      ok: false,
      reason: 'cached count columns do not match derived final-state counts',
      derived,
    };
  }

  return { ok: true, derived };
}
