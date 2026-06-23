import { describe, it, expect } from 'vitest';
import {
  canTransitionTo,
  isAllowedPauseReason,
  isTerminalStatus,
  canResumeFrom,
} from '../../src/runtime/job-state.js';

describe('canTransitionTo (§11.1)', () => {
  it('allows created → running', () => {
    expect(canTransitionTo('created', 'running')).toBe(true);
  });
  it('allows running → paused', () => {
    expect(canTransitionTo('running', 'paused')).toBe(true);
  });
  it('allows running → interrupted', () => {
    expect(canTransitionTo('running', 'interrupted')).toBe(true);
  });
  it('allows running → completed', () => {
    expect(canTransitionTo('running', 'completed')).toBe(true);
  });
  it('allows paused → running (resume)', () => {
    expect(canTransitionTo('paused', 'running')).toBe(true);
  });
  it('allows interrupted → running', () => {
    expect(canTransitionTo('interrupted', 'running')).toBe(true);
  });
  it('allows running → failed', () => {
    expect(canTransitionTo('running', 'failed')).toBe(true);
  });
  it('disallows completed → running', () => {
    expect(canTransitionTo('completed', 'running')).toBe(false);
  });
  it('disallows paused → completed', () => {
    expect(canTransitionTo('paused', 'completed')).toBe(false);
  });
  it('disallows created → completed', () => {
    expect(canTransitionTo('created', 'completed')).toBe(false);
  });
});

describe('isAllowedPauseReason (§11.1)', () => {
  it('accepts all five spec reasons', () => {
    expect(isAllowedPauseReason('auth_required')).toBe(true);
    expect(isAllowedPauseReason('challenge_required')).toBe(true);
    expect(isAllowedPauseReason('rate_limited')).toBe(true);
    expect(isAllowedPauseReason('manual_intervention_required')).toBe(true);
    expect(isAllowedPauseReason('operator_paused')).toBe(true);
  });
  it('rejects unknown reason', () => {
    expect(isAllowedPauseReason('bogus' as never)).toBe(false);
  });
});

describe('isTerminalStatus (§11.1)', () => {
  it('completed and failed are terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
  });
  it('paused and interrupted are NOT terminal', () => {
    expect(isTerminalStatus('paused')).toBe(false);
    expect(isTerminalStatus('interrupted')).toBe(false);
  });
});

describe('canResumeFrom (§11.1)', () => {
  it('can resume from paused or interrupted', () => {
    expect(canResumeFrom('paused')).toBe(true);
    expect(canResumeFrom('interrupted')).toBe(true);
  });
  it('cannot resume from completed or running', () => {
    expect(canResumeFrom('completed')).toBe(false);
    expect(canResumeFrom('running')).toBe(false);
  });
});
