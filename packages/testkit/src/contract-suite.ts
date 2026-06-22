import { beforeEach, describe, it, expect } from 'vitest';
import {
  isAdapterApiCompatible,
  type SourceAdapter,
  type TargetAdapter,
} from '@inkmigrate/core';

/**
 * §24.2 来源适配器契约测试套件。
 *
 * 适配器包在自己的测试中调用：
 *
 * ```ts
 * import { runSourceAdapterContract } from '@inkmigrate/testkit';
 * describe('my-source', () => {
 *   runSourceAdapterContract(() => makeMyAdapter());
 * });
 * ```
 *
 * 每个适配器都必须通过本套件，覆盖 §24.2 列出的来源侧契约。
 */
export function runSourceAdapterContract(
  makeAdapter: () => SourceAdapter,
  opts: { expectCleanupImplemented?: boolean } = {},
): void {
  describe('source adapter contract (§24.2)', () => {
    let adapter: SourceAdapter;
    beforeEach(() => {
      adapter = makeAdapter();
    });

    it('declares a valid adapterApiVersion in the supported range', () => {
      expect(isAdapterApiCompatible(adapter.adapterApiVersion)).toBe(true);
    });

    it('declares a non-empty stable kind', () => {
      expect(typeof adapter.kind).toBe('string');
      expect(adapter.kind.length).toBeGreaterThan(0);
    });

    it('declares a non-empty impl version', () => {
      expect(typeof adapter.version).toBe('string');
      expect(adapter.version.length).toBeGreaterThan(0);
    });

    it('capabilities object is consistent with §8.2 cleanup invariant', () => {
      const c = adapter.capabilities;
      expect(Array.isArray(c.cleanupActions)).toBe(true);
      expect(Array.isArray(c.supportedInputFormats)).toBe(true);
      if (c.supportsSourceCleanup === false) {
        expect(c.cleanupActions).toEqual([]);
        expect(adapter.cleanup).toBeUndefined();
      } else {
        expect(adapter.cleanup).toBeDefined();
        expect(c.cleanupActions.length).toBeGreaterThan(0);
      }
    });

    it('scan is an async generator (§8.2)', () => {
      // 不实际驱动 scan；只校验返回 AsyncGenerator。
      // 注意：调用方应在自己的 fixture 测试中驱动真实扫描。
      const result = adapter.scan({
        config: {},
        workspaceDir: '.',
      });
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
    });

    if (opts.expectCleanupImplemented) {
      it('cleanup adapter is present when capability declared', () => {
        expect(adapter.cleanup).toBeDefined();
      });
    }
  });
}

/**
 * §24.2 目标适配器契约测试套件。
 */
export function runTargetAdapterContract(
  makeAdapter: () => TargetAdapter,
): void {
  describe('target adapter contract (§24.2)', () => {
    let adapter: TargetAdapter;
    beforeEach(() => {
      adapter = makeAdapter();
    });

    it('declares a valid adapterApiVersion in the supported range', () => {
      expect(isAdapterApiCompatible(adapter.adapterApiVersion)).toBe(true);
    });

    it('declares a non-empty stable kind', () => {
      expect(typeof adapter.kind).toBe('string');
      expect(adapter.kind.length).toBeGreaterThan(0);
    });

    it('declares a non-empty impl version', () => {
      expect(typeof adapter.version).toBe('string');
      expect(adapter.version.length).toBeGreaterThan(0);
    });
  });
}
