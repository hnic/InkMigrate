export type SourceContentKind =
  | 'article'
  | 'short-post'
  | 'gallery'
  | 'question-answer'
  | 'video'
  | 'note'
  | 'external-link'
  | 'unknown';

export const SOURCE_CONTENT_KINDS: readonly SourceContentKind[] = [
  'article',
  'short-post',
  'gallery',
  'question-answer',
  'video',
  'note',
  'external-link',
  'unknown',
];

export type SourceItemQuality = 'full' | 'degraded';

/** §8.5 `SourceDegradation.stage` 合法值 */
export const SOURCE_DEGRADATION_STAGES = [
  'scan',
  'extract',
  'normalize',
  'assets',
] as const;
export type SourceDegradationStage = (typeof SOURCE_DEGRADATION_STAGES)[number];

export type SourceDegradationCode =
  | 'content-unavailable'
  | 'body-missing'
  | 'partial-visibility'
  | 'metadata-only'
  | 'unsupported-structure'
  | 'asset-incomplete'
  | 'unresolved-embedded-content'
  | 'unknown';

export const SOURCE_DEGRADATION_CODES: readonly SourceDegradationCode[] = [
  'content-unavailable',
  'body-missing',
  'partial-visibility',
  'metadata-only',
  'unsupported-structure',
  'asset-incomplete',
  'unresolved-embedded-content',
  'unknown',
];

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
   * 下载后的图片/附件字节。由 source adapter 在 extract 时填充（best-effort）。
   * target adapter 在 plan/write 时将其落地到 Vault Attachments 目录。
   * 不参与 sourceContentHash（hash 只用 metadata 字段）。
   * fixture-driven 测试不填充此字段。
   */
  bytes?: Buffer;
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

export function isSourceContentKind(v: unknown): v is SourceContentKind {
  return (
    typeof v === 'string' &&
    (SOURCE_CONTENT_KINDS as readonly string[]).includes(v)
  );
}

export function isSourceItemQuality(v: unknown): v is SourceItemQuality {
  return v === 'full' || v === 'degraded';
}

export function isSourceDegradationCode(
  v: unknown,
): v is SourceDegradationCode {
  return (
    typeof v === 'string' &&
    (SOURCE_DEGRADATION_CODES as readonly string[]).includes(v)
  );
}

export function isSourceDegradationStage(
  v: unknown,
): v is SourceDegradationStage {
  return (
    typeof v === 'string' &&
    (SOURCE_DEGRADATION_STAGES as readonly string[]).includes(v)
  );
}

/**
 * 校验单个降级项的结构完整性：合法 code、合法 stage、非空 message。
 * 不在本节判断 code 与 stage 是否相互匹配（例如 `asset-incomplete`/`scan` 的组合合理性），
 * 该规则由来源适配器自行约束。
 */
export function validateSourceDegradation(d: SourceDegradation, index: number): void {
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
