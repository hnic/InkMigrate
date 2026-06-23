import type { FingerprintInput } from '@inkmigrate/core';

export interface DeriveInput {
  /** §12.6 priority 1：今日头条内容 ID。 */
  contentId?: string;
  /** §12.6 priority 2：规范化 URL。 */
  canonicalUrl?: string;
  /** §12.6 priority 3：标题/作者/发布时间（当无 ID/URL 时）。 */
  title?: string;
  author?: string;
  publishedAt?: string;
  /** §12.6 priority 4：原始 URL 兜底。 */
  originalUrl?: string;
}

/**
 * §12.6 4 级优先级身份推导，返回 core `computeFingerprint` 接受的输入对象。
 *
 * - L1：contentId（外部 ID）
 * - L2：canonicalUrl
 * - L3：title + author + publishedAt
 * - L4：originalUrl 作为 raw
 *
 * 任一上层有值就用上层；下层字段不再混入（避免 fingerprint 输入不稳定）。
 */
export function deriveFingerprintInput(i: DeriveInput): FingerprintInput {
  if (i.contentId !== undefined && i.contentId.length > 0) {
    const out: FingerprintInput = { externalId: i.contentId };
    if (i.canonicalUrl !== undefined) out.canonicalUrl = i.canonicalUrl;
    return out;
  }
  if (i.canonicalUrl !== undefined && i.canonicalUrl.length > 0) {
    return { canonicalUrl: i.canonicalUrl };
  }
  if (
    i.title !== undefined ||
    i.author !== undefined ||
    i.publishedAt !== undefined
  ) {
    const out: FingerprintInput = {};
    if (i.title !== undefined) out.title = i.title;
    if (i.author !== undefined) out.author = i.author;
    if (i.publishedAt !== undefined) out.publishedAt = i.publishedAt;
    return out;
  }
  return { raw: i.originalUrl ?? '' };
}
