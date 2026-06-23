import { describe, it, expect } from 'vitest';
import { verifyUnfavoriteResult } from '../../src/cleanup/action-verifier.js';
import { loadCleanupFixture } from '../helpers/fixtures.js';

describe('verifyUnfavoriteResult (§14.10)', () => {
  it('returns verified when button changed + success toast', () => {
    const r = verifyUnfavoriteResult(loadCleanupFixture('unfavorite-success'));
    expect(r.verified).toBe(true);
    expect(r.strongSignal).toBe(true);
    expect(r.auxiliarySignal).toBe(true);
  });
  it('returns not_verified when still favorited + error', () => {
    expect(verifyUnfavoriteResult(loadCleanupFixture('unfavorite-failed')).verified).toBe(false);
  });
  it('returns unknown when button state is ambiguous', () => {
    const r = verifyUnfavoriteResult(loadCleanupFixture('ambiguous-button-state'));
    expect(r.verified).toBe(false);
    expect(r.strongSignal).toBe(false);
  });
  it('returns verified with only strong signal (no toast)', () => {
    const r = verifyUnfavoriteResult('<button data-testid="favorite-button" aria-pressed="false">收藏</button>');
    expect(r.strongSignal).toBe(true);
    expect(r.auxiliarySignal).toBe(false);
    expect(r.verified).toBe(true);
  });
});
