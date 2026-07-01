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
/**
 * H7: extract 上下文扩展可选 AbortSignal。适配器可在 extract 内部监听该信号
 * 以支持进行中提取的协作式取消（如中断长导航），而非只能等条目间检查。
 * 可选字段——mock/fixture/旧适配器无需改；真实适配器可选使用。
 */
export interface ExtractContext extends AdapterContext {
  /** 取消信号；适配器可在长操作前检查 signal.aborted 或传给底层库。 */
  signal?: AbortSignal;
}
export type VerifyContext = AdapterContext;

export interface TargetContext extends AdapterContext {
  vaultPath: string;
  /** §10.2 目标适配器运行时配置（已通过适配器自己的 Zod schema 校验）。 */
  targetConfig: Record<string, unknown>;
  /**
   * §13.8 renderIndex 输入：本 Job 已写入/验证的笔记条目，供目标适配器生成索引。
   * 仅在生成索引阶段由 Job Runner 填充；plan/write/verify 阶段忽略此字段。
   * 可选 → 不实现 renderIndex 的适配器与旧调用方不受影响。
   */
  indexEntries?: readonly IndexEntryInput[];
  /** §13.8 renderIndex 用：当前 Job 的来源实例 ID（构造索引目录路径）。仅索引阶段填充。 */
  sourceInstanceId?: string;
  /** §13.8 renderIndex 用：当前 Job 已落库的索引 artifact（relativePath + 哈希），用于重跑保护。 */
  knownIndexArtifacts?: readonly { relativePath: string; writtenFileHash: string }[];
}

/**
 * §13.8 索引条目输入（核心定义，目标适配器按需映射到自己的 IndexEntry）。
 * 字段对齐分片索引分组维度（month/content-type/collection）。
 */
export interface IndexEntryInput {
  title: string;
  /** 笔记相对 Vault 根的路径（含 .md）。 */
  relativePath: string;
  contentKind: string;
  publishedAt?: string;
  favoritedAt?: string;
  collections: readonly string[];
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
/** §8.3 cleanup 操作状态。 */
export interface CleanupActionState {
  state: 'favorited' | 'not-favorited' | 'unknown';
}

/** §8.3 cleanup 执行结果。 */
export interface CleanupActionReceipt {
  success: boolean;
  wasCollected?: boolean;
  isCollected?: boolean;
  reason?: string;
  /**
   * §5/§14.12 检测到的特殊页面状态（登录墙/风控挑战/内容不可用）。
   * 驱动编排器对 login/challenge 走受控中断（而非 15 分钟硬等）；content_unavailable
   * 视为跳过。可选 + additive → 旧调用方不受影响。
   */
  detectedState?: 'login_required' | 'challenge_required' | 'content_unavailable';
}

/** §8.3 cleanup 验证结果。 */
export interface CleanupVerification {
  verified: boolean;
  details?: string;
}

export interface SourceCleanupAdapter {
  readonly supportedActions: readonly string[];
  inspectActionState(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<CleanupActionState>;
  executeAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<CleanupActionReceipt>;
  verifyAction(
    ref: SourceItemRef,
    action: string,
    ctx: CleanupContext,
  ): Promise<CleanupVerification>;
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
  /** §16.4 source_content_hash（标准化正文哈希），由 target adapter 在 plan 时计算。 */
  sourceContentHash?: string;
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
  /**
   * §13.9 可选：传入上次成功写入的 expectedWrittenFileHash，
   * 适配器据此检测目标文件是否被用户修改（用于 conflict 判定）。
   * 如果适配器不支持，忽略此参数。
   */
  writeWithExpectedHash?(plan: TargetPlan, ctx: TargetContext, expectedWrittenFileHash?: string): Promise<TargetWriteResult>;
  verify(
    result: TargetWriteResult,
    ctx: VerifyContext,
  ): Promise<TargetVerification>;
  /** §13.8 通用目标适配器可不支持索引；obsidian v1.1 必须实现 */
  renderIndex?(ctx: TargetContext): Promise<TargetWriteResult[]>;
}
