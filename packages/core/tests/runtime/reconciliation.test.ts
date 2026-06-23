import { describe, it, expect } from 'vitest';
import {
  deriveFinalStateCounts,
  reconcileJob,
} from '../../src/runtime/reconciliation.js';
import type { ItemFinalState } from '../../src/domain/states.js';

describe('deriveFinalStateCounts (§11.9)', () => {
  it('counts each final state from a list of item states', () => {
    const states: ItemFinalState[] = [
      'verified',
      'verified',
      'degraded',
      'permanent_failed',
      'unsupported',
      'blocked',
      'conflict',
      'skipped',
    ];
    const counts = deriveFinalStateCounts(states);
    expect(counts.verified).toBe(2);
    expect(counts.degraded).toBe(1);
    expect(counts.permanent_failed).toBe(1);
    expect(counts.unsupported).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.conflict).toBe(1);
    expect(counts.skipped).toBe(1);
  });
});

describe('reconcileJob (§11.9 完整性方程)', () => {
  it('passes when scan_count equals sum of final states with 0 recoverable', () => {
    const result = reconcileJob({
      scanCount: 10,
      itemStates: [
        'verified', 'verified', 'verified', 'verified', 'verified',
        'degraded', 'permanent_failed', 'conflict', 'skipped', 'unsupported',
      ],
      recoverableCount: 0,
      cachedCounts: {
        verified_count: 5, degraded_count: 1, failed_count: 2,
        conflict_count: 1, skipped_count: 1,
      },
    });
    expect(result.ok).toBe(true);
  });

  it('fails when equation does not balance', () => {
    const result = reconcileJob({
      scanCount: 100,
      itemStates: ['verified'],
      recoverableCount: 0,
      cachedCounts: {
        verified_count: 1, degraded_count: 0, failed_count: 0,
        conflict_count: 0, skipped_count: 0,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/equation|integrity/i);
  });

  it('fails when recoverable > 0', () => {
    const result = reconcileJob({
      scanCount: 5,
      itemStates: ['verified', 'verified', 'verified', 'verified', 'verified'],
      recoverableCount: 2,
      cachedCounts: {
        verified_count: 5, degraded_count: 0, failed_count: 0,
        conflict_count: 0, skipped_count: 0,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/recoverable|hanging/i);
  });

  it('fails when derived failed_count != cached failed_count', () => {
    const result = reconcileJob({
      scanCount: 5,
      itemStates: [
        'verified', 'verified', 'verified', 'permanent_failed', 'unsupported',
      ],
      recoverableCount: 0,
      cachedCounts: {
        verified_count: 3, degraded_count: 0, failed_count: 1,
        conflict_count: 0, skipped_count: 0,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed_count|mismatch/i);
  });
});
