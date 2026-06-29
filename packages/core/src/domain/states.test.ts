import { describe, it, expect } from 'vitest';
import {
  JOB_STATUS,
  JOB_PAUSE_REASONS,
  CURRENT_STAGES,
  ITEM_FINAL_STATES,
  ITEM_RECOVERABLE_STATES,
  ITEM_PROCESSING_STATES,
  ARTIFACT_STATUSES,
  ARTIFACT_KINDS,
  ATTEMPT_SCOPES,
  ACTION_CODES,
  COMPLETION_EQUATION_TERMS,
  verifyCompletionEquation,
  aggregateFailedCount,
  isItemFinalState,
  isItemRecoverableState,
} from './states.js';

describe('states (§11.1, §16.6)', () => {
  describe('enum surface', () => {
    it('exposes job lifecycle statuses', () => {
      expect(JOB_STATUS).toEqual([
        'created',
        'running',
        'paused',
        'interrupted',
        'completed',
        'failed',
      ]);
    });
    it('exposes all pause reasons from §11.1', () => {
      expect(JOB_PAUSE_REASONS).toEqual([
        'auth_required',
        'challenge_required',
        'rate_limited',
        'manual_intervention_required',
        'operator_paused',
      ]);
    });
    it('exposes current_stage pipeline in order', () => {
      expect(CURRENT_STAGES).toEqual([
        'preflight',
        'scanning',
        'planning',
        'extracting',
        'normalizing',
        'transferring_assets',
        'writing_target',
        'verifying_target',
        'generating_indexes',
        'reporting',
        'completed',
      ]);
    });
    it('separates recoverable from final item states', () => {
      expect(ITEM_RECOVERABLE_STATES).toEqual([
        'retryable_failed',
        'interrupted',
      ]);
      for (const s of ITEM_RECOVERABLE_STATES) {
        expect(ITEM_FINAL_STATES).not.toContain(s);
        expect(ITEM_PROCESSING_STATES).not.toContain(s);
      }
    });
    it('exposes artifact statuses with §16.6 controlled values', () => {
      expect(ARTIFACT_STATUSES).toEqual([
        'planned',
        'written',
        'verified',
        'conflict',
        'superseded',
        'invalid',
      ]);
    });
    it('exposes artifact kinds with §16.6 controlled values', () => {
      expect(ARTIFACT_KINDS).toEqual([
        'note',
        'note_variant',
        'index',
        'report',
        'manifest',
      ]);
    });
    it('exposes attempt scopes and action codes', () => {
      expect(ATTEMPT_SCOPES).toEqual(['job', 'item']);
      expect(ACTION_CODES).toEqual([
        'stage_attempt',
        'source_update',
        'quality_upgrade',
        'forced_overwrite',
        'write_new_variant',
        'metadata_update',
      ]);
    });
  });

  describe('completion equation (§11.9)', () => {
    it('terms match the allowed final states values (含 §13 rate_limited)', () => {
      expect(COMPLETION_EQUATION_TERMS).toEqual([
        'verified',
        'degraded',
        'permanent_failed',
        'unsupported',
        'blocked',
        'conflict',
        'skipped',
        'rate_limited',
      ]);
      // every term must be a recognized final state
      for (const t of COMPLETION_EQUATION_TERMS) {
        expect(ITEM_FINAL_STATES).toContain(t);
      }
    });
    it('verifies balanced equation', () => {
      expect(
        verifyCompletionEquation({
          scanCount: 100,
          counts: {
            verified: 80,
            degraded: 5,
            permanent_failed: 3,
            unsupported: 2,
            blocked: 1,
            conflict: 4,
            skipped: 5,
            rate_limited: 0,
          },
          recoverable: 0,
        }),
      ).toBe(true);
    });
    it('rejects unbalanced equation', () => {
      expect(
        verifyCompletionEquation({
          scanCount: 100,
          counts: {
            verified: 70,
            degraded: 5,
            permanent_failed: 3,
            unsupported: 2,
            blocked: 1,
            conflict: 4,
            skipped: 5,
            rate_limited: 0,
          },
          recoverable: 0,
        }),
      ).toBe(false);
    });
    it('rejects if recoverable > 0', () => {
      expect(
        verifyCompletionEquation({
          scanCount: 100,
          counts: {
            verified: 79,
            degraded: 5,
            permanent_failed: 3,
            unsupported: 2,
            blocked: 1,
            conflict: 4,
            skipped: 5,
            rate_limited: 0,
          },
          recoverable: 1,
        }),
      ).toBe(false);
    });
  });

  describe('aggregateFailedCount (§11.9)', () => {
    it('sums permanent_failed + unsupported + blocked only', () => {
      expect(
        aggregateFailedCount({
          verified: 10,
          degraded: 2,
          permanent_failed: 3,
          unsupported: 2,
          blocked: 1,
          conflict: 4,
          skipped: 5,
          rate_limited: 0,
        }),
      ).toBe(6);
    });
    it('returns 0 when no failed-class states', () => {
      expect(
        aggregateFailedCount({
          verified: 100,
          degraded: 0,
          permanent_failed: 0,
          unsupported: 0,
          blocked: 0,
          conflict: 0,
          skipped: 0,
          rate_limited: 0,
        }),
      ).toBe(0);
    });
  });

  describe('isItemFinalState / isItemRecoverableState', () => {
    it('recognizes final states', () => {
      expect(isItemFinalState('verified')).toBe(true);
      expect(isItemFinalState('blocked')).toBe(true);
      expect(isItemFinalState('retryable_failed')).toBe(false);
      expect(isItemFinalState('extracting')).toBe(false);
    });
    it('recognizes recoverable states', () => {
      expect(isItemRecoverableState('retryable_failed')).toBe(true);
      expect(isItemRecoverableState('interrupted')).toBe(true);
      expect(isItemRecoverableState('verified')).toBe(false);
    });
  });
});
