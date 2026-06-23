export type PreActionState =
  | 'favorited' | 'not_favorited' | 'unknown'
  | 'login_required' | 'challenge_required' | 'content_unavailable';

export interface CleanupActionDecision {
  action: 'execute' | 'skip' | 'pause';
  shouldClick: boolean;
  finalState?: string;
  pauseReason?: string;
}

/** §14.8 + §14.12 根据操作前状态决定清理动作。 */
export function decideCleanupAction(input: { preActionState: PreActionState }): CleanupActionDecision {
  switch (input.preActionState) {
    case 'favorited': return { action: 'execute', shouldClick: true };
    case 'not_favorited': return { action: 'skip', shouldClick: false, finalState: 'already_unfavorited' };
    case 'unknown': return { action: 'skip', shouldClick: false, finalState: 'state_unknown' };
    case 'login_required': return { action: 'pause', shouldClick: false, pauseReason: 'login_required' };
    case 'challenge_required': return { action: 'pause', shouldClick: false, pauseReason: 'challenge_required' };
    case 'content_unavailable': return { action: 'skip', shouldClick: false, finalState: 'skipped' };
  }
}
