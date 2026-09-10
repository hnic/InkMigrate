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
 *
 * 空白口径与 core 对齐：core `computeFingerprint` 会 trim 每个字段并把纯空白
 * 视为空。本函数各级守卫同样按"trim 后非空"判定并输出 trim 后的值——否则
 * 空白串会赢下该级却让 core 看到全空输入而抛错，破坏 4 级回退链。
 *
 * L3 的已知权衡：字段集按"实际有值"参与（不同采集完整度 → 不同指纹）。本仓
 * 生产路径 canonicalUrl 恒存在（L2 必先命中），L3 实际不触发；若把 L3 钉死为
 * 全字段集，稀疏采集会跌到 L4 的 originalUrl——它未规范化，追踪参数差异反而
 * 产生不同指纹，稳定性更差，故维持现口径。
 */
export function deriveFingerprintInput(i: DeriveInput): FingerprintInput {
  // §I2：L1 命中时只输出 externalId，不再混入 canonicalUrl。
  // 否则同一篇文章被采集两次（一次带 externalId、一次不带）会产生不同 SHA-256
  // 指纹 → 重复迁移。上层有值就用上层，下层字段（URL）不再混入。
  const contentId = i.contentId?.trim();
  if (contentId !== undefined && contentId.length > 0) {
    return { externalId: contentId };
  }
  const canonicalUrl = i.canonicalUrl?.trim();
  if (canonicalUrl !== undefined && canonicalUrl.length > 0) {
    return { canonicalUrl };
  }
  // L3 仅在至少一个字段 trim 后非空时启用；空串/纯空白不参与（见类注释空白口径）
  const title = i.title?.trim();
  const author = i.author?.trim();
  const publishedAt = i.publishedAt?.trim();
  if (
    (title !== undefined && title.length > 0) ||
    (author !== undefined && author.length > 0) ||
    (publishedAt !== undefined && publishedAt.length > 0)
  ) {
    const out: FingerprintInput = {};
    if (title !== undefined && title.length > 0) out.title = title;
    if (author !== undefined && author.length > 0) out.author = author;
    if (publishedAt !== undefined && publishedAt.length > 0) out.publishedAt = publishedAt;
    return out;
  }
  // L4 兜底：originalUrl 也为空时在此显式失败——延迟到 core 抛
  // "all identity fields are empty" 会丢失是哪条目/哪级失败的上下文。
  if (i.originalUrl === undefined || i.originalUrl.trim().length === 0) {
    throw new Error(
      'deriveFingerprintInput: no identity fields available (contentId/canonicalUrl/title/author/publishedAt/originalUrl all empty)',
    );
  }
  return { raw: i.originalUrl };
}
