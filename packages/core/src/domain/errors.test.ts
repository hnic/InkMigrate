import { describe, it, expect } from 'vitest';
import {
  assertItemDispositionContract,
  ADAPTER_ERROR_DISPOSITION_MISSING,
  ITEM_DISPOSITIONS,
  ERROR_CATEGORIES,
  isErrorCategory,
  isItemDisposition,
  toInkMigrateError,
  type InkMigrateError,
} from './errors.js';

const baseErr = (overrides: Partial<InkMigrateError>): InkMigrateError => ({
  code: 'X',
  category: 'network',
  retryable: true,
  userMessage: 'm',
  ...overrides,
});

describe('errors (§20.2, §11.5)', () => {
  describe('enum surface', () => {
    it('exposes the three item dispositions', () => {
      expect(ITEM_DISPOSITIONS).toEqual([
        'permanent_failed',
        'unsupported',
        'blocked',
      ]);
    });
    it('exposes all §20.2 categories', () => {
      expect(ERROR_CATEGORIES).toEqual([
        'config',
        'auth',
        'network',
        'parse',
        'extract',
        'asset',
        'target',
        'verify',
        'cleanup',
        'internal',
      ]);
    });
  });

  describe('type guards', () => {
    it('isErrorCategory accepts spec values, rejects others', () => {
      expect(isErrorCategory('auth')).toBe(true);
      expect(isErrorCategory('AUTH')).toBe(false);
      expect(isErrorCategory(undefined)).toBe(false);
    });
    it('isItemDisposition accepts spec values, rejects others', () => {
      expect(isItemDisposition('blocked')).toBe(true);
      expect(isItemDisposition('retryable_failed')).toBe(false);
    });
  });

  describe('assertItemDispositionContract', () => {
    it('retryable=true must not carry itemDisposition', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({ retryable: true, itemDisposition: 'blocked' }),
        ),
      ).toThrow(/retryable/);
    });
    it('item-level non-retryable must carry itemDisposition', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({ category: 'extract', retryable: false }),
          'item',
        ),
      ).toThrow(new RegExp(ADAPTER_ERROR_DISPOSITION_MISSING));
    });
    it('item-level non-retryable error carries valid itemDisposition → passes', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({
            category: 'extract',
            retryable: false,
            itemDisposition: 'permanent_failed',
          }),
          'item',
        ),
      ).not.toThrow();
    });
    it('job-level non-retryable may omit itemDisposition', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({ category: 'auth', retryable: false }),
          'job',
        ),
      ).not.toThrow();
    });
    it('job-level error carrying itemDisposition is rejected (§20.2 rule 1)', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({
            category: 'auth',
            retryable: false,
            itemDisposition: 'blocked',
          }),
          'job',
        ),
      ).toThrow(/job-level/);
    });
    it('item-level with unknown itemDisposition value is rejected', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({
            category: 'extract',
            retryable: false,
            itemDisposition: 'made-up' as never,
          }),
          'item',
        ),
      ).toThrow(/itemDisposition/);
    });
    it('default scope is item', () => {
      expect(() =>
        assertItemDispositionContract(
          baseErr({ category: 'extract', retryable: false }),
        ),
      ).toThrow(new RegExp(ADAPTER_ERROR_DISPOSITION_MISSING));
    });
  });

  describe('toInkMigrateError', () => {
    it('returns an Error instance carrying all domain fields', () => {
      const e = toInkMigrateError(
        baseErr({
          code: 'EXTRACT_FAILED',
          category: 'extract',
          retryable: false,
          itemDisposition: 'permanent_failed',
          userMessage: 'extraction failed',
          technicalMessage: 'stack trace',
        }),
      );
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe('extraction failed');
      expect(e.code).toBe('EXTRACT_FAILED');
      expect(e.category).toBe('extract');
      expect(e.retryable).toBe(false);
      expect(e.itemDisposition).toBe('permanent_failed');
      expect(e.technicalMessage).toBe('stack trace');
    });
    it('omits technicalMessage/itemDisposition when absent (exactOptional)', () => {
      const e = toInkMigrateError(baseErr({ retryable: true }));
      expect(e.technicalMessage).toBeUndefined();
      expect(e.itemDisposition).toBeUndefined();
    });
  });
});
