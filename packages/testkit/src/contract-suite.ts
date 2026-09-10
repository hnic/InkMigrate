import { beforeEach, describe, it, expect } from 'vitest';
import {
  isAdapterApiCompatible,
  type SourceAdapter,
  type TargetAdapter,
} from '@inkmigrate/core';

/** adapterApiVersion / kind / version 声明契约（§24.2），来源与目标套件共用。 */
function runAdapterDeclarationContract(
  makeAdapter: () => { adapterApiVersion: string; kind: string; version: string },
): void {
  it('declares a valid adapterApiVersion in the supported range', () => {
    const { adapterApiVersion } = makeAdapter();
    expect(isAdapterApiCompatible(adapterApiVersion)).toBe(true);
  });

  it('declares a non-empty stable kind', () => {
    const { kind } = makeAdapter();
    expect(typeof kind).toBe('string');
    expect(kind.length).toBeGreaterThan(0);
  });

  it('declares a non-empty impl version', () => {
    const { version } = makeAdapter();
    expect(typeof version).toBe('string');
    expect(version.length).toBeGreaterThan(0);
  });
}

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

    runAdapterDeclarationContract(makeAdapter);

    it('capabilities object is consistent with §8.2 cleanup invariant', () => {
      const c = adapter.capabilities;
      expect(Array.isArray(c.cleanupActions)).toBe(true);
      expect(Array.isArray(c.supportedInputFormats)).toBe(true);
      // 与 AdapterRegistry.registerSource 的真值分支语义对齐（undefined 视为不支持）
      expect(typeof c.supportsSourceCleanup).toBe('boolean');
      if (c.supportsSourceCleanup === true) {
        expect(adapter.cleanup).toBeDefined();
        expect(c.cleanupActions.length).toBeGreaterThan(0);
      } else {
        expect(c.cleanupActions).toEqual([]);
        expect(adapter.cleanup).toBeUndefined();
      }
    });

    it('scan is an async generator (§8.2)', async () => {
      // 不实际驱动 scan；只校验返回 AsyncGenerator。
      // 注意：调用方应在自己的 fixture 测试中驱动真实扫描。
      // 契约只承诺"返回 AsyncGenerator"，但同步校验 config 的适配器会在返回前
      // 抛错——用清晰的契约错误包装，避免泄漏适配器自身的校验信息造成困惑。
      const result = (() => {
        try {
          return adapter.scan({ config: {}, workspaceDir: '.' });
        } catch (err) {
          throw new Error(
            `scan must not throw synchronously for the fixture context (got: ${String(err)})`,
          );
        }
      })();
      try {
        expect(typeof result[Symbol.asyncIterator]).toBe('function');
      } finally {
        // 未启动的生成器调用 return() 不会执行函数体（含其 finally 块），这里仅是
        // 防御性关闭；await 并捕获 rejection，避免不可归因的 unhandled rejection。
        if (typeof result.return === 'function') {
          await result.return(undefined).catch(() => {});
        }
      }
    });

    if (opts.expectCleanupImplemented) {
      it('declares supportsSourceCleanup=true and provides a cleanup adapter', () => {
        expect(adapter.capabilities.supportsSourceCleanup).toBe(true);
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

    runAdapterDeclarationContract(makeAdapter);

    // §8.4 运行时必需方法的存在性：契约套件正是为了抓住 TypeScript 抓不到的
    // 运行时形状违规（纯 JS 适配器、构建错配）。
    it('exposes the required §8.4 target methods', () => {
      expect(typeof adapter.validateConfig).toBe('function');
      expect(typeof adapter.plan).toBe('function');
      expect(typeof adapter.write).toBe('function');
      expect(typeof adapter.verify).toBe('function');
    });
  });
}
