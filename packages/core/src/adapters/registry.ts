import type { SourceAdapter, TargetAdapter } from './adapter.js';
import { isAdapterApiCompatible } from './api-version.js';

/**
 * §8.6 在适配器 API 版本不兼容时抛出。CLI 层捕获后以退出码 `16` 退出。
 */
export class IncompatibleAdapterApiError extends Error {
  constructor(
    public readonly adapterKind: string,
    public readonly adapterApiVersion: string,
  ) {
    super(
      `adapter "${adapterKind}" api ${adapterApiVersion} is incompatible with core`,
    );
    this.name = 'IncompatibleAdapterApiError';
  }
}

/**
 * §8 适配器注册表。来源与目标分别注册；启动时校验 API 兼容性。
 * 核心包不依赖任何具体适配器，适配器由 `apps/cli` 或上层组装注入。
 */
export class AdapterRegistry {
  private sources = new Map<string, SourceAdapter>();
  private targets = new Map<string, TargetAdapter>();

  registerSource(adapter: SourceAdapter): void {
    this.checkApi(adapter.kind, adapter.adapterApiVersion);
    this.checkCleanupInvariant(adapter);
    if (this.sources.has(adapter.kind)) {
      throw new Error(`source adapter "${adapter.kind}" already registered`);
    }
    this.sources.set(adapter.kind, adapter);
  }

  registerTarget(adapter: TargetAdapter): void {
    this.checkApi(adapter.kind, adapter.adapterApiVersion);
    if (this.targets.has(adapter.kind)) {
      throw new Error(`target adapter "${adapter.kind}" already registered`);
    }
    this.targets.set(adapter.kind, adapter);
  }

  getSource(kind: string): SourceAdapter {
    const a = this.sources.get(kind);
    if (!a) throw new Error(`source adapter "${kind}" not registered`);
    return a;
  }

  getTarget(kind: string): TargetAdapter {
    const a = this.targets.get(kind);
    if (!a) throw new Error(`target adapter "${kind}" not registered`);
    return a;
  }

  listSources(): readonly string[] {
    return [...this.sources.keys()];
  }

  listTargets(): readonly string[] {
    return [...this.targets.keys()];
  }

  private checkApi(kind: string, api: string): void {
    if (!isAdapterApiCompatible(api)) {
      throw new IncompatibleAdapterApiError(kind, api);
    }
  }

  /**
   * §8.2 不变量：若 `supportsSourceCleanup === false`，则 `cleanup` 必须为
   * `undefined` 且 `cleanupActions` 必须为空；若为 `true`，则 `cleanup` 必须存在。
   * 注册时强制校验，避免适配器声明与实现不一致。
   */
  private checkCleanupInvariant(adapter: SourceAdapter): void {
    const c = adapter.capabilities;
    if (c.supportsSourceCleanup) {
      if (adapter.cleanup === undefined) {
        throw new Error(
          `source adapter "${adapter.kind}" declares supportsSourceCleanup=true but provides no cleanup adapter`,
        );
      }
      if (c.cleanupActions.length === 0) {
        throw new Error(
          `source adapter "${adapter.kind}" declares supportsSourceCleanup=true but lists no cleanupActions`,
        );
      }
    } else {
      if (adapter.cleanup !== undefined) {
        throw new Error(
          `source adapter "${adapter.kind}" declares supportsSourceCleanup=false but provides a cleanup adapter`,
        );
      }
      if (c.cleanupActions.length > 0) {
        throw new Error(
          `source adapter "${adapter.kind}" declares supportsSourceCleanup=false but lists cleanupActions [${c.cleanupActions.join(', ')}]`,
        );
      }
    }
  }
}
