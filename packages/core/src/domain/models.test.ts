import { describe, it, expect } from 'vitest';
import {
  isSourceItemQuality,
  isSourceDegradationCode,
  isSourceContentKind,
  isSourceDegradationStage,
  validateSourceItemQuality,
  validateSourceDegradation,
  type SourceDegradation,
} from './models.js';

const okDegradation = (overrides: Partial<SourceDegradation> = {}): SourceDegradation => ({
  code: 'body-missing',
  stage: 'extract',
  message: 'extraction fell back to metadata-only',
  ...overrides,
});

describe('models quality contract (§8.5)', () => {
  describe('isSourceItemQuality', () => {
    it('accepts full and degraded', () => {
      expect(isSourceItemQuality('full')).toBe(true);
      expect(isSourceItemQuality('degraded')).toBe(true);
    });
    it('rejects case variants, undefined, null, look-alikes', () => {
      expect(isSourceItemQuality('FULL')).toBe(false);
      expect(isSourceItemQuality(undefined)).toBe(false);
      expect(isSourceItemQuality(null)).toBe(false);
      expect(isSourceItemQuality('degraded-ish')).toBe(false);
      expect(isSourceItemQuality(1)).toBe(false);
    });
  });

  describe('isSourceDegradationCode', () => {
    it('accepts every spec-defined code', () => {
      const codes = [
        'content-unavailable',
        'body-missing',
        'partial-visibility',
        'metadata-only',
        'unsupported-structure',
        'asset-incomplete',
        'unresolved-embedded-content',
        'unknown',
      ];
      for (const c of codes) expect(isSourceDegradationCode(c)).toBe(true);
    });
    it('rejects unknown and non-string', () => {
      expect(isSourceDegradationCode('made-up')).toBe(false);
      expect(isSourceDegradationCode(undefined)).toBe(false);
      expect(isSourceDegradationCode(42)).toBe(false);
    });
  });

  describe('isSourceContentKind', () => {
    it('accepts spec kinds', () => {
      expect(isSourceContentKind('article')).toBe(true);
      expect(isSourceContentKind('unknown')).toBe(true);
    });
    it('rejects unknown', () => {
      expect(isSourceContentKind('Article')).toBe(false);
      expect(isSourceContentKind('made-up')).toBe(false);
    });
  });

  describe('isSourceDegradationStage', () => {
    it('accepts spec stages', () => {
      expect(isSourceDegradationStage('scan')).toBe(true);
      expect(isSourceDegradationStage('extract')).toBe(true);
      expect(isSourceDegradationStage('normalize')).toBe(true);
      expect(isSourceDegradationStage('assets')).toBe(true);
    });
    it('rejects unknown', () => {
      expect(isSourceDegradationStage('import')).toBe(false);
    });
  });

  describe('validateSourceDegradation', () => {
    it('passes a well-formed degradation', () => {
      expect(() => validateSourceDegradation(okDegradation(), 0)).not.toThrow();
    });
    it('rejects invalid code', () => {
      expect(() =>
        validateSourceDegradation(okDegradation({ code: 'made-up' as never }), 0),
      ).toThrow(/code/);
    });
    it('rejects invalid stage', () => {
      expect(() =>
        validateSourceDegradation(okDegradation({ stage: 'import' as never }), 2),
      ).toThrow(/stage/);
    });
    it('rejects empty message', () => {
      expect(() =>
        validateSourceDegradation(okDegradation({ message: '' }), 0),
      ).toThrow(/message/);
    });
    it('includes index in error message', () => {
      try {
        validateSourceDegradation(okDegradation({ message: '' }), 3);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/\[3\]/);
      }
    });
  });

  describe('validateSourceItemQuality', () => {
    it('happy path: full with empty degradations', () => {
      expect(() => validateSourceItemQuality('full', [])).not.toThrow();
    });
    it('happy path: degraded with one degradation', () => {
      expect(() =>
        validateSourceItemQuality('degraded', [okDegradation()]),
      ).not.toThrow();
    });
    it('happy path: degraded with multiple degradations', () => {
      expect(() =>
        validateSourceItemQuality('degraded', [
          okDegradation({ code: 'asset-incomplete', stage: 'assets' }),
          okDegradation({ code: 'body-missing', stage: 'extract' }),
        ]),
      ).not.toThrow();
    });
    it('rejects full with degradations, message lists offending codes', () => {
      expect(() =>
        validateSourceItemQuality('full', [
          okDegradation({ code: 'body-missing' }),
          okDegradation({ code: 'asset-incomplete', stage: 'assets' }),
        ]),
      ).toThrow(/body-missing.*asset-incomplete|asset-incomplete.*body-missing/);
    });
    it('rejects degraded with no degradations', () => {
      expect(() => validateSourceItemQuality('degraded', [])).toThrow(
        /at least one/,
      );
    });
    it('defensively rejects unknown quality value', () => {
      expect(() =>
        validateSourceItemQuality('foo', []),
      ).toThrow(/quality must be 'full' or 'degraded'/);
    });
    it('rejects degraded list with one malformed entry', () => {
      expect(() =>
        validateSourceItemQuality('degraded', [
          okDegradation(),
          okDegradation({ message: '' }),
        ]),
      ).toThrow(/\[1\].*message/);
    });
  });
});
