import { describe, it, expect } from 'vitest';
import { checkEligibility, type EligibilityInput } from '../../src/runtime/cleanup-eligibility.js';

const valid: EligibilityInput = {
  artifactKind: 'note', artifactStatus: 'verified', sourceItemQuality: 'full',
  noteExists: true, noteNonZero: true, yamlParseable: true, hasSourceIdOrUrl: true,
  dbTargetConsistent: true, noUnresolvedConflict: true, notInTransitionalState: true,
  notAlreadyUnfavorited: true,
};

describe('checkEligibility (§14.4)', () => {
  it('passes all checks', () => { expect(checkEligibility(valid).eligible).toBe(true); });
  it('fails: artifact_kind != note', () => { expect(checkEligibility({ ...valid, artifactKind: 'note_variant' }).eligible).toBe(false); });
  it('fails: status != verified', () => { expect(checkEligibility({ ...valid, artifactStatus: 'written' }).eligible).toBe(false); });
  it('fails: quality != full', () => { expect(checkEligibility({ ...valid, sourceItemQuality: 'degraded' }).eligible).toBe(false); });
  it('fails: note missing', () => { expect(checkEligibility({ ...valid, noteExists: false }).eligible).toBe(false); });
  it('fails: conflict', () => { expect(checkEligibility({ ...valid, noUnresolvedConflict: false }).eligible).toBe(false); });
  it('fails: already unfavorited', () => { expect(checkEligibility({ ...valid, notAlreadyUnfavorited: false }).eligible).toBe(false); });
  it('returns multiple reasons', () => {
    const r = checkEligibility({ ...valid, sourceItemQuality: 'degraded', noteExists: false });
    expect(r.eligible).toBe(false);
    expect(r.reasons.length).toBe(2);
  });
});
