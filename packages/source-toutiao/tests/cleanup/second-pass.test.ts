import { describe, it, expect } from 'vitest';
import { resolveSecondPassResult } from '../../src/cleanup/second-pass.js';

describe('resolveSecondPassResult (§14.11)', () => {
  it('confirmed_absent → unfavorited_verified', () => { expect(resolveSecondPassResult('confirmed_absent')).toBe('unfavorited_verified'); });
  it('still_present → verification_failed', () => { expect(resolveSecondPassResult('still_present')).toBe('verification_failed'); });
  it('unable_to_confirm → action_result_unknown', () => { expect(resolveSecondPassResult('unable_to_confirm')).toBe('action_result_unknown'); });
});
