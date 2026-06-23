import type { SourceCapabilities } from '../domain/capabilities.js';
import type {
  SourceItem,
  SourceItemRef,
} from '../domain/models.js';
import type { ArtifactKind } from '../domain/states.js';

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

export interface AdapterContext {
  config: unknown;
  workspaceDir: string;
}

export type ScanContext = AdapterContext;
export type ExtractContext = AdapterContext;
export type VerifyContext = AdapterContext;

export interface TargetContext extends AdapterContext {
  vaultPath: string;
  /** §10.2 目标适配器运行时配置（已通过适配器自己的 Zod schema 校验）。 */
  targetConfig: Record<string, unknown>;
}
export interface CleanupContext extends AdapterContext {}

/**
 * §8.2 `verifySourceRef` 的返回状态。规格未在 §8 中细化字段，这里给出最小集合，
 * 用于在不访问完整 SourceItem 的情况下判断 Ref 是否仍然可解析。
 */
export interface SourceRefState {
  /** 当前是否能从来源解析该 Ref（条目仍存在、未失效、未删除）。 */
  resolvable: boolean;
  /** 来源给出的当前可见性或可访问性说明，例如 `available`/`deleted`/`login_required`。 */
  availability?:
    | 'available'
    | 'deleted'
    | 'login_required'
    | 'challenge_required'
    | 'unknown';
  /** 适配器附加状态（不强制结构）。 */
  metadata?: Record<string, unknown>;
}

export type { SourceCapabilities };

/**
 * §8.3 源端清理适配器接口。仅当 `SourceCapabilities.supportsSourceCleanup === true`
 * 时由来源适配器实例提供。
 */
export interface SourceCleanupAdapter {
  readonly supportedActions: readonly string[];
  inspectActionState(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<unknown>;
  executeAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<unknown>;
  verifyAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<unknown>;
}

/** §8.2 来源适配器接口。 */
export interface SourceAdapter {
  readonly kind: string;
  /** 适配器实现/包版本，例如 1.4.2 */
  readonly version: string;
  /** 与 @inkmigrate/core 的契约版本，例如 1.0.0；与 `version` 不得混用 */
  readonly adapterApiVersion: string;
  readonly capabilities: SourceCapabilities;
  readonly cleanup?: SourceCleanupAdapter;
  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  prepare(ctx: AdapterContext): Promise<void>;
  scan(ctx: ScanContext): AsyncGenerator<SourceItemRef>;
  extract(ref: SourceItemRef, ctx: ExtractContext): Promise<SourceItem>;
  verifySourceRef?(
    ref: SourceItemRef,
    ctx: VerifyContext,
  ): Promise<SourceRefState>;
  close(): Promise<void>;
}

/** §8.4 目标适配器 plan/write/verify 结果类型 */
export interface TargetPlan {
  relativePath: string;
  /** §16.6 受控值，由 ARTIFACT_KINDS 枚举约束。 */
  artifactKind: ArtifactKind;
}

export interface TargetWriteResult {
  relativePath: string;
  targetContentHash: string;
  writtenFileHash: string;
}

export interface TargetVerification {
  ok: boolean;
  details?: unknown;
}

/** §8.4 目标适配器接口。`renderIndex` 在通用接口中保持可选。 */
export interface TargetAdapter {
  readonly kind: string;
  readonly version: string;
  readonly adapterApiVersion: string;
  validateConfig(ctx: AdapterContext): Promise<ValidationResult>;
  plan(item: SourceItem, ctx: TargetContext): Promise<TargetPlan>;
  write(plan: TargetPlan, ctx: TargetContext): Promise<TargetWriteResult>;
  verify(
    result: TargetWriteResult,
    ctx: VerifyContext,
  ): Promise<TargetVerification>;
  /** §13.8 通用目标适配器可不支持索引；obsidian v1.1 必须实现 */
  renderIndex?(ctx: TargetContext): Promise<TargetWriteResult[]>;
}
