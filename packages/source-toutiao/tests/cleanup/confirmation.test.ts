import { describe, it, expect } from 'vitest';
import { validateConfirmation, buildConfirmationPrompt } from '../../src/cleanup/confirmation.js';

describe('validateConfirmation (§14.6)', () => {
  it('accepts exact match', () => { expect(validateConfirmation('UNFAVORITE 87', 87, 'UNFAVORITE')).toBe(true); });
  it('rejects wrong count', () => { expect(validateConfirmation('UNFAVORITE 86', 87, 'UNFAVORITE')).toBe(false); });
  it('rejects wrong prefix', () => { expect(validateConfirmation('DELETE 87', 87, 'UNFAVORITE')).toBe(false); });
  it('rejects whitespace', () => { expect(validateConfirmation('  UNFAVORITE 87  ', 87, 'UNFAVORITE')).toBe(false); });
  it('rejects empty', () => { expect(validateConfirmation('', 87, 'UNFAVORITE')).toBe(false); });
});

describe('buildConfirmationPrompt', () => {
  it('builds prompt', () => {
    const p = buildConfirmationPrompt(87, 'UNFAVORITE');
    expect(p).toContain('87');
    expect(p).toContain('UNFAVORITE 87');
  });
});
