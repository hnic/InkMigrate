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
  return JOB_TRANSITIONS[status].size === 0;
}

/** §11.1 resume 只能从 paused 或 interrupted 恢复。 */
export function canResumeFrom(status: JobStatus): boolean {
  // 派生自转换矩阵：可转到 running 且此前已启动过。created → running 是首次启动
  // 而非 resume，故排除；终态在矩阵中本就无 → running 出边。
  return status !== 'created' && canJobTransition(status, 'running');
}
