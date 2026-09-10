import type { ItemFinalState, ItemRecoverableState, FinalStateCounts } from '../domain/states.js';
import {
  aggregateFailedCount,
  isItemFinalState,
  isItemRecoverableState,
  COMPLETION_EQUATION_TERMS,
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
  // 委托 domain 守卫判定可恢复态（守卫注释明确为此而设），消除
  // `as readonly string[]` 强转与词表的又一份字面量复制。
  const recoverableInStates = i.itemStates.filter((s) =>
    isItemRecoverableState(s),
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

  // 未知条目状态（既非终态也非可恢复态，可能来自存储脏值——reconcileJob 是
  // 公开导出、itemStates 可能未经校验）：若不单独报告，只会被下方等式静默
  // 跳过，等式检查给出误导性的 scan_count≠sum，运维无法区分「存在未知态
  // 条目」与「计数损坏」。fail-closed 语义不变，仅让失败原因可诊断——与
  // 上方 recoverable 失同步预检对称。
  const unknownStates = [
    ...new Set(
      i.itemStates.filter((s) => !isItemFinalState(s) && !isItemRecoverableState(s)),
    ),
  ];
  if (unknownStates.length > 0) {
    return {
      ok: false,
      reason: `unknown item states present: ${JSON.stringify(unknownStates)}`,
    };
  }

  const derived = deriveFinalStateCounts(i.itemStates);
  const derivedFailed = aggregateFailedCount(derived);

  // §11.9 完整性方程按 domain 的等式词表（COMPLETION_EQUATION_TERMS，单一
  // 真相源）归约求和，与 verifyCompletionEquation 严格同口径；不借道
  // aggregateFailedCount——它与等式相符依赖「failed 聚合恰好包含
  // permanent_failed + unsupported + blocked」这一聚合口径，口径一变等式就会
  // 无提示地断裂。此前手写七项求和虽显式，但新增第 8 个终态时不会编译报错、
  // 只会静默漏加一项（FinalStateCounts 的 Record 键反而会迫使调用方补齐），
  // 改为词表归约后结构性免疫漂移。derivedFailed 仅用于下方与缓存列的对比。
  const sum = COMPLETION_EQUATION_TERMS.reduce((acc, term) => acc + derived[term], 0);
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
