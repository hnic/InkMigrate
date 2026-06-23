import { describe, it, expect } from 'vitest';
import { decideCleanupAction } from '../../src/cleanup/cleanup-state-machine.js';

describe('decideCleanupAction (§14.8 + §14.12)', () => {
  it('favorited → execute', () => { expect(decideCleanupAction({ preActionState: 'favorited' }).action).toBe('execute'); });
  it('not_favorited → skip already_unfavorited, no click', () => {
    const d = decideCleanupAction({ preActionState: 'not_favorited' });
    expect(d.action).toBe('skip'); expect(d.finalState).toBe('already_unfavorited'); expect(d.shouldClick).toBe(false);
  });
  it('unknown → skip state_unknown', () => {
    const d = decideCleanupAction({ preActionState: 'unknown' });
    expect(d.action).toBe('skip'); expect(d.finalState).toBe('state_unknown');
  });
  it('login_required → pause', () => {
    const d = decideCleanupAction({ preActionState: 'login_required' });
    expect(d.action).toBe('pause'); expect(d.pauseReason).toBe('login_required');
  });
  it('challenge_required → pause', () => {
    const d = decideCleanupAction({ preActionState: 'challenge_required' });
    expect(d.action).toBe('pause'); expect(d.pauseReason).toBe('challenge_required');
  });
  it('content_unavailable → skip', () => { expect(decideCleanupAction({ preActionState: 'content_unavailable' }).action).toBe('skip'); });
});
