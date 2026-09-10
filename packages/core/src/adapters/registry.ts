import type {
  SourceAdapter,
  SourceCapabilities,
  TargetAdapter,
} from './adapter.js';
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
    this.registerIfAbsent(this.sources, 'source', adapter);
  }

  registerTarget(adapter: TargetAdapter): void {
    this.checkApi(adapter.kind, adapter.adapterApiVersion);
    this.registerIfAbsent(this.targets, 'target', adapter);
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
   * 共享的注册收尾（查重 + 入表）：source/target 两侧的注册校验序列保持同构，
   * 后续新增不变量时只需在两侧各自的 check* 中扩展，收尾逻辑不再各持一份。
   */
  private registerIfAbsent<T extends { kind: string }>(
    map: Map<string, T>,
    role: 'source' | 'target',
    adapter: T,
  ): void {
    if (map.has(adapter.kind)) {
      throw new Error(`${role} adapter "${adapter.kind}" already registered`);
    }
    map.set(adapter.kind, adapter);
  }

  /**
   * §8.2 不变量：若 `supportsSourceCleanup === false`，则 `cleanup` 必须为
   * `undefined` 且 `cleanupActions` 必须为空；若为 `true`，则 `cleanup` 必须存在。
   * 注册时强制校验，避免适配器声明与实现不一致。
   */
  private checkCleanupInvariant(adapter: SourceAdapter): void {
    // 适配器由上层动态组装注入（可能绕过 TS 类型的裸对象），先做形状检查：
    // 缺 capabilities / cleanupActions 不是数组时给出可读的契约错误，
    // 而不是裸 TypeError（与 isAdapterApiCompatible 对畸形版本串的容错口径一致）。
    const c = adapter.capabilities as Partial<SourceCapabilities> | undefined;
    if (c === undefined || !Array.isArray(c.cleanupActions)) {
      throw new Error(
        `source adapter "${adapter.kind}" must expose capabilities with a cleanupActions array`,
      );
    }
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
