import { describe, it, expect } from 'vitest';
import {
  computeFingerprint,
  computeStableKey,
  deriveItemKey,
  deriveStableShortId,
  buildInkmigrateId,
  pickNonCollidingLength,
  STABLE_SHORT_ID_LADDER,
  ITEM_KEY_LADDER,
} from './stable-keys.js';

describe('stable-keys (§4, §13.4)', () => {
  describe('computeFingerprint', () => {
    it('produces sha256:<64 lowercase hex>', () => {
      const fp = computeFingerprint({ externalId: 'abc', canonicalUrl: 'u' });
      expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
    it('is deterministic for same input', () => {
      const a = computeFingerprint({ externalId: 'abc' });
      const b = computeFingerprint({ externalId: 'abc' });
      expect(a).toBe(b);
    });
    it('ignores undefined fields (stable across partial inputs)', () => {
      const a = computeFingerprint({ externalId: 'abc' });
      const b = computeFingerprint({ externalId: 'abc' });
      expect(a).toBe(b);
    });
    it('distinguishes different inputs', () => {
      expect(computeFingerprint({ externalId: 'abc' })).not.toBe(
        computeFingerprint({ externalId: 'abd' }),
      );
    });
    it('supports raw fingerprint input for sources without structured id', () => {
      expect(computeFingerprint({ raw: 'whatever' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('computeStableKey', () => {
    it('is sha256(sourceInstanceId + "\\0" + fingerprint) hex 64', () => {
      const fp = 'sha256:' + 'a'.repeat(64);
      const sk = computeStableKey('toutiao-main', fp);
      expect(sk).toMatch(/^[0-9a-f]{64}$/);
    });
    it('is deterministic', () => {
      const fp = 'sha256:' + 'a'.repeat(64);
      expect(computeStableKey('toutiao-main', fp)).toBe(
        computeStableKey('toutiao-main', fp),
      );
    });
    it('differs per source instance (same fingerprint)', () => {
      const fp = 'sha256:' + 'a'.repeat(64);
      expect(computeStableKey('toutiao-main', fp)).not.toBe(
        computeStableKey('toutiao-other', fp),
      );
    });
    it('differs per fingerprint (same instance)', () => {
      const fp1 = 'sha256:' + 'a'.repeat(64);
      const fp2 = 'sha256:' + 'b'.repeat(64);
      expect(computeStableKey('toutiao-main', fp1)).not.toBe(
        computeStableKey('toutiao-main', fp2),
      );
    });
    it('null byte separates fields (no ambiguity from concatenation)', () => {
      // 'ab' + 'c' vs 'a' + 'bc' must not collide
      const a = computeStableKey('ab', 'c');
      const b = computeStableKey('a', 'bc');
      expect(a).not.toBe(b);
    });
  });

  describe('deriveItemKey', () => {
    it('is im-<stableKey first 16 chars> by default', () => {
      const sk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(deriveItemKey(sk)).toBe('im-0123456789abcdef');
    });
    it('respects custom length', () => {
      const sk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(deriveItemKey(sk, 24)).toBe('im-0123456789abcdef01234567');
    });
  });

  describe('deriveStableShortId', () => {
    it('is stableKey first 10 chars by default', () => {
      const sk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(deriveStableShortId(sk)).toBe('0123456789');
    });
    it('respects custom length', () => {
      const sk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(deriveStableShortId(sk, 16)).toBe('0123456789abcdef');
    });
  });

  describe('buildInkmigrateId', () => {
    it('is im:<instance>:<stableKey>', () => {
      const sk = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(buildInkmigrateId('toutiao-main', sk)).toBe(
        'im:toutiao-main:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      );
    });
  });

  describe('pickNonCollidingLength', () => {
    const full = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    it('exposes spec-defined ladders (§4, §13.4)', () => {
      expect(STABLE_SHORT_ID_LADDER).toEqual([10, 16]);
      expect(ITEM_KEY_LADDER).toEqual([16, 24]);
    });

    it('returns first ladder value when no collision', () => {
      expect(pickNonCollidingLength(full, STABLE_SHORT_ID_LADDER, ['9999999999'])).toBe(10);
    });
    it('empty existing list → first ladder value', () => {
      expect(pickNonCollidingLength(full, STABLE_SHORT_ID_LADDER, [])).toBe(10);
    });

    describe('Stable Short ID ladder {10, 16, full}', () => {
      it('collision at 10 → jumps to 16 (never 11-15)', () => {
        const other = '0123456789' + 'f'.repeat(54);
        const result = pickNonCollidingLength(full, STABLE_SHORT_ID_LADDER, [
          other.slice(0, 10),
        ]);
        expect(result).toBe(16);
      });
      it('collision at 10 and 16 → full (64)', () => {
        // another key sharing first 16 chars with `full`
        const other = full.slice(0, 16) + '9'.repeat(48);
        const result = pickNonCollidingLength(full, STABLE_SHORT_ID_LADDER, [
          other.slice(0, 10),
          other.slice(0, 16),
        ]);
        expect(result).toBe(64);
      });
      it('never returns intermediate value 11-15', () => {
        const other = '0123456789' + 'f'.repeat(54);
        const result = pickNonCollidingLength(full, STABLE_SHORT_ID_LADDER, [
          other.slice(0, 10),
        ]);
        expect(result).not.toBeGreaterThan(16);
        expect(result).not.toBeLessThan(16);
      });
    });

    describe('Item Key ladder {16, 24, full}', () => {
      it('collision at 16 → jumps to 24 (never 17-23)', () => {
        const other = full.slice(0, 16) + '9'.repeat(48);
        const result = pickNonCollidingLength(full, ITEM_KEY_LADDER, [
          other.slice(0, 16),
        ]);
        expect(result).toBe(24);
      });
      it('collision at 16 and 24 → full (64)', () => {
        const other = full.slice(0, 24) + '9'.repeat(40);
        const result = pickNonCollidingLength(full, ITEM_KEY_LADDER, [
          other.slice(0, 16),
          other.slice(0, 24),
        ]);
        expect(result).toBe(64);
      });
    });

    it('ladder value >= key length returns full key length', () => {
      const shortKey = '0123456789abcdef'; // length 16
      // ladder [10, 16] against a 16-char key: 10 first, but if it collides go to 16 (=full)
      expect(
        pickNonCollidingLength(shortKey, STABLE_SHORT_ID_LADDER, [
          'XXXXXXXXXX',
        ]),
      ).toBe(10);
      expect(
        pickNonCollidingLength(shortKey, STABLE_SHORT_ID_LADDER, [
          shortKey.slice(0, 10),
        ]),
      ).toBe(16);
    });

    it('rejects empty ladder', () => {
      expect(() => pickNonCollidingLength(full, [], [])).toThrow(/empty/);
    });
    it('rejects non-ascending ladder', () => {
      expect(() => pickNonCollidingLength(full, [16, 10], [])).toThrow(
        /ascending/,
      );
      expect(() => pickNonCollidingLength(full, [10, 10], [])).toThrow(
        /ascending/,
      );
    });
  });
});
