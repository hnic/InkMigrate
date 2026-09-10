import {
  canJobTransition,
  isJobPauseReason,
  JOB_TRANSITIONS,
  type JobStatus,
  type JobPauseReason,
} from '../domain/states.js';

/**
 * §11.1 Job status 合法转换（委托给 domain 层单一真相源，M9）。
 */
export function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  return canJobTransition(from, to);
}

export function isAllowedPauseReason(
  reason: string,
): reason is JobPauseReason {
  // 委托 domain 判定源，避免本地复制 JOB_PAUSE_REASONS 后新增 reason 漂移失同步。
  return isJobPauseReason(reason);
}

export function isTerminalStatus(status: JobStatus): boolean {
  // 终态 = 转换矩阵无出边，从 JOB_TRANSITIONS 派生而非硬编码状态名。
  // 与 canJobTransition 同口径：运行期越界 status（如存储读出的脏值、
  // JSON 未检查的断言转换）返回 false 而非抛 TypeError——本函数经 index.ts
  // 对外导出，调用方可能喂入脏数据。用自身属性检查而非 ?.：'__proto__' 等
  // 原型链键经 ?. 会取到非空对象（其 .size 为 undefined，虽不抛但口径不一）。
  const row = Object.prototype.hasOwnProperty.call(JOB_TRANSITIONS, status)
    ? JOB_TRANSITIONS[status]
    : undefined;
  return row !== undefined && row.size === 0;
}

/** §11.1 resume 只能从 paused 或 interrupted 恢复。 */
export function canResumeFrom(status: JobStatus): boolean {
  // 派生自转换矩阵：可转到 running 且此前已启动过。created → running 是首次启动
  // 而非 resume，故排除；终态在矩阵中本就无 → running 出边。
  return status !== 'created' && canJobTransition(status, 'running');
}
