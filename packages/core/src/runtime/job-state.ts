import { canJobTransition, type JobStatus, type JobPauseReason } from '../domain/states.js';

/**
 * §11.1 Job status 合法转换（委托给 domain 层单一真相源，M9）。
 */
export function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  return canJobTransition(from, to);
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
