import type { JobStatus, JobPauseReason } from '../domain/states.js';

/**
 * §11.1 Job status 合法转换矩阵。
 *
 * paused 不是终态；从 paused 恢复必须先复核暂停原因。
 * interrupted 恢复前必须重检悬挂状态。
 * completed/failed 是终态，不可再转换。
 */
const TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  created: new Set<JobStatus>(['running', 'failed']),
  running: new Set<JobStatus>([
    'paused',
    'interrupted',
    'completed',
    'failed',
  ]),
  paused: new Set<JobStatus>(['running', 'failed']),
  interrupted: new Set<JobStatus>(['running', 'failed']),
  completed: new Set<JobStatus>(),
  failed: new Set<JobStatus>(),
};

export function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].has(to);
}

/** §11.1 受控 paused 的允许触发条件。 */
const ALLOWED_PAUSE_REASONS: ReadonlySet<JobPauseReason> = new Set([
  'auth_required',
  'challenge_required',
  'rate_limited',
  'manual_intervention_required',
  'operator_paused',
]);

export function isAllowedPauseReason(
  reason: string,
): reason is JobPauseReason {
  return ALLOWED_PAUSE_REASONS.has(reason as JobPauseReason);
}

export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** §11.1 resume 只能从 paused 或 interrupted 恢复。 */
export function canResumeFrom(status: JobStatus): boolean {
  return status === 'paused' || status === 'interrupted';
}
