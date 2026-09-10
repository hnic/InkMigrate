// 词表用 `as const` 声明、类型从数组派生（与 SOURCE_DEGRADATION_STAGES 同一模式）：
// 手工并列维护的联合类型与运行时数组必然漂移，派生后新增成员只改一处。
export const SOURCE_CONTENT_KINDS = [
  'article',
  'short-post',
  'gallery',
  'question-answer',
  'video',
  'note',
  'external-link',
  'unknown',
] as const;
export type SourceContentKind = (typeof SOURCE_CONTENT_KINDS)[number];

export type SourceItemQuality = 'full' | 'degraded';

/** §8.5 `SourceDegradation.stage` 合法值 */
export const SOURCE_DEGRADATION_STAGES = [
  'scan',
  'extract',
  'normalize',
  'assets',
] as const;
export type SourceDegradationStage = (typeof SOURCE_DEGRADATION_STAGES)[number];

export const SOURCE_DEGRADATION_CODES = [
  'content-unavailable',
  'body-missing',
  'partial-visibility',
  'metadata-only',
  'unsupported-structure',
  'asset-incomplete',
  'unresolved-embedded-content',
  'unknown',
] as const;
export type SourceDegradationCode =
  (typeof SOURCE_DEGRADATION_CODES)[number];

export interface SourceDegradation {
  code: SourceDegradationCode;
  stage: SourceDegradationStage;
  message: string;
}

export interface SourceItemRef {
  sourceInstanceId: string;
  externalId?: string;
  canonicalUrl?: string;
  originalUrl?: string;
  title?: string;
  contentKind: SourceContentKind;
  discoveredAt: string;
  sourcePosition?: number;
  fingerprint: string;
  sourceMetadata: Record<string, unknown>;
}

export interface SourceAsset {
  externalId?: string;
  originalUrl?: string;
  mimeType?: string;
  byteSize?: number;
  sha256?: string;
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'office' | 'other';
  /**
   * §15.7.4 来源侧已清洗的落盘文件名（含扩展名，冲突已消解）。
   * Evernote 等携带原文件名的来源设置；头条等按序号命名的来源不设置，
   * 目标端对未设置的资产维持原有序号命名行为。
   */
  fileName?: string;
  /**
   * 瞬态：下载的资源字节（仅 image 下载成功时填充）。
   * 不参与序列化、不进 sourceContentHash；只在同一次迁移的进程内从 extract
   * 流到 plan/write（processOneItem 内串行完成）。跨进程/持久化后失效。
   */
  data?: Uint8Array;
}

export interface SourceLink {
  text: string;
  url: string;
  kind: 'external' | 'internal';
}

export interface SourceItem {
  ref: SourceItemRef;
  title: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  favoritedAt?: string;
  bodyHtml?: string;
  bodyText?: string;
  summary?: string;
  tags: string[];
  collections: string[];
  assets: SourceAsset[];
  links: SourceLink[];
  quality: SourceItemQuality;
  degradations: SourceDegradation[];
  extractionMethod: string;
  extractionWarnings: string[];
  sourceMetadata: Record<string, unknown>;
}

/** 词表守卫的通用构造器（与 domain/states.ts 的 makeStringGuard 同一模式）。 */
function isOneOf<T extends readonly string[]>(
  values: T,
  v: unknown,
): v is T[number] {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

export function isSourceContentKind(v: unknown): v is SourceContentKind {
  return isOneOf(SOURCE_CONTENT_KINDS, v);
}

export function isSourceItemQuality(v: unknown): v is SourceItemQuality {
  return v === 'full' || v === 'degraded';
}

export function isSourceDegradationCode(
  v: unknown,
): v is SourceDegradationCode {
  return isOneOf(SOURCE_DEGRADATION_CODES, v);
}

export function isSourceDegradationStage(
  v: unknown,
): v is SourceDegradationStage {
  return isOneOf(SOURCE_DEGRADATION_STAGES, v);
}

/**
 * 校验单个降级项的结构完整性：合法 code、合法 stage、非空 message。
 * 不在本节判断 code 与 stage 是否相互匹配（例如 `asset-incomplete`/`scan` 的组合合理性），
 * 该规则由来源适配器自行约束。
 */
export function validateSourceDegradation(d: SourceDegradation, index: number): void {
  // 持久化前的防御门可能接到松类型/解析来的数据：null/undefined 数组元素
  // 先给出可读的校验错误，而不是裸 TypeError 掩盖真正的数据问题
  if (d === null || typeof d !== 'object') {
    throw new Error(
      `degradations[${index}] must be a non-null object, got: ${String(d)}`,
    );
  }
  if (!isSourceDegradationCode(d.code)) {
    throw new Error(
      `degradations[${index}].code is not a valid SourceDegradationCode: ${String(d.code)}`,
    );
  }
  if (!isSourceDegradationStage(d.stage)) {
    throw new Error(
      `degradations[${index}].stage is not a valid SourceDegradationStage: ${String(d.stage)}`,
    );
  }
  if (typeof d.message !== 'string' || d.message.length === 0) {
    throw new Error(
      `degradations[${index}].message must be a non-empty string`,
    );
  }
}

/**
 * §8.5 质量契约的完整校验，在持久化 `SourceItem` 前调用。
 *
 * - 拒绝未知的 `quality` 值（防御性，即便 TS 类型已约束）。
 * - `quality: 'full'` 必须不带任何 degradation。
 * - `quality: 'degraded'` 必须至少带一条 degradation。
 * - 每条 degradation 必须有合法 code、合法 stage 和非空 message。
 */
export function validateSourceItemQuality(
  quality: unknown,
  degradations: ReadonlyArray<SourceDegradation>,
): void {
  if (!isSourceItemQuality(quality)) {
    throw new Error(
      `quality must be 'full' or 'degraded', got: ${String(quality)}`,
    );
  }
  degradations.forEach((d, i) => validateSourceDegradation(d, i));
  if (quality === 'full' && degradations.length > 0) {
    throw new Error(
      `quality=full requires empty degradations, got ${degradations.length}` +
        ` (codes: ${degradations.map((d) => d.code).join(', ')})`,
    );
  }
  if (quality === 'degraded' && degradations.length === 0) {
    throw new Error('quality=degraded requires at least one degradation');
  }
}
