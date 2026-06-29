import type { ItemFinalState, ItemRecoverableState, FinalStateCounts } from '../domain/states.js';
import { aggregateFailedCount } from '../domain/states.js';

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
    // 仅统计已知完成终态；可恢复态（interrupted/retryable_failed）跳过，不计入等式
    if (s in counts) {
      counts[s as keyof FinalStateCounts]++;
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
  if (i.recoverableCount > 0) {
    return {
      ok: false,
      reason: `integrity check failed: ${i.recoverableCount} recoverable items still hanging`,
    };
  }

  const derived = deriveFinalStateCounts(i.itemStates);
  const derivedFailed = aggregateFailedCount(derived);

  const sum =
    derived.verified +
    derived.degraded +
    derivedFailed +
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
