import { describe, it, expect } from 'vitest';
import { isQualityUpgradeCandidate } from '../../src/runtime/quality-upgrade.js';

describe('isQualityUpgradeCandidate (§17.5)', () => {
  it('returns true when previous=degraded and new=full with empty degradations', () => {
    expect(
      isQualityUpgradeCandidate({
        previousQuality: 'degraded',
        newQuality: 'full',
        newDegradations: [],
      }),
    ).toBe(true);
  });

  it('returns false when previous was already full', () => {
    expect(
      isQualityUpgradeCandidate({
        previousQuality: 'full',
        newQuality: 'full',
        newDegradations: [],
      }),
    ).toBe(false);
  });

  it('returns false when new extraction is still degraded', () => {
    expect(
      isQualityUpgradeCandidate({
        previousQuality: 'degraded',
        newQuality: 'degraded',
        newDegradations: [
          { code: 'body-missing', stage: 'extract', message: 'x' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false when new is full but has degradations (contract violation)', () => {
    expect(
      isQualityUpgradeCandidate({
        previousQuality: 'degraded',
        newQuality: 'full',
        newDegradations: [
          { code: 'body-missing', stage: 'extract', message: 'x' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false when previous was not degraded (first migration)', () => {
    expect(
      isQualityUpgradeCandidate({
        previousQuality: undefined,
        newQuality: 'full',
        newDegradations: [],
      }),
    ).toBe(false);
  });
});
