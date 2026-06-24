import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import {
  type SourceAsset,
  type SourceItem,
  type SourceItemRef,
  validateSourceItemQuality,
} from '@inkmigrate/core';
import { extractDetail } from '../extract/detail-extractor.js';

export interface ExtractDriverOptions {
  page: Page;
  ref: SourceItemRef;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
  /** §12.10 单张图片大小上限。 */
  maxImageBytes?: number;
}

/** 允许的图片 MIME 类型。 */
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Magic bytes 前缀检查。 */
const MAGIC_SIGNATURES: ReadonlyArray<{
  mime: string;
  prefix: ReadonlyArray<number>;
}> = [
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', prefix: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * §12.8 浏览器驱动的详情页提取。
 *
 * 流程：
 * 1. 导航到 ref.canonicalUrl，等待 networkidle。
 * 2. 获取页面 HTML，交给 extractDetail（结构化数据 + readability + 安全流水线）。
 * 3. 对 detail.images 中的每张图片通过浏览器上下文下载（best-effort）。
 *    - 下载成功：asset 带 sha256/byteSize/mimeType。
 *    - 下载失败：asset 仅保留 originalUrl（metadata-only），不影响 quality。
 * 4. 返回完整 SourceItem。
 *
 * Readability 在 extractDetail 内部对独立 jsdom 克隆运行，不修改 Playwright 页面（§12.8）。
 * 图片下载使用 page.request（APIRequestContext），共享浏览器 Cookie 和 UA，
 * 适用于需要签名验证的头条 CDN 图片（§12.10）。
 */
export async function driveExtractDetail(
  opts: ExtractDriverOptions,
): Promise<SourceItem> {
  const url = opts.ref.canonicalUrl;
  if (url === undefined) {
    throw new Error('SourceItemRef has no canonicalUrl; cannot navigate');
  }

  await opts.page.goto(url, {
    waitUntil: 'networkidle',
    timeout: opts.navigationTimeoutMs ?? 45_000,
  });

  const html = await opts.page.content();
  const detail = extractDetail({
    html,
    canonicalUrl: url,
    originalUrl: opts.ref.originalUrl ?? url,
  });

  // §12.10 best-effort 图片下载（使用浏览器上下文，共享 Cookie/UA）
  const maxBytes = opts.maxImageBytes ?? 50 * 1024 * 1024;
  const assets: SourceAsset[] = [];
  for (const imgUrl of detail.images) {
    const asset: SourceAsset = { originalUrl: imgUrl, kind: 'image' };
    const dl = await downloadViaBrowser(opts.page, imgUrl, maxBytes);
    if (dl !== undefined) {
      asset.mimeType = dl.mimeType;
      asset.byteSize = dl.byteSize;
      asset.sha256 = `sha256:${dl.sha256}`;
      asset.bytes = dl.bytes;
    }
    assets.push(asset);
  }

  const quality = detail.quality;
  const degradations = detail.degradations;
  validateSourceItemQuality(quality, degradations);

  const item: SourceItem = {
    ref: opts.ref,
    title: detail.title,
    tags: [],
    collections: [],
    assets,
    links: [],
    quality,
    degradations,
    extractionMethod: 'browser',
    extractionWarnings: [],
    sourceMetadata: {},
  };
  if (detail.author !== undefined) item.author = detail.author;
  if (detail.publishedAt !== undefined) item.publishedAt = detail.publishedAt;
  if (detail.markdown) item.bodyText = detail.markdown;
  if (detail.html) item.bodyHtml = detail.html;
  return item;
}

/**
 * 通过 Playwright 浏览器上下文下载图片，共享 Cookie 和 UA。
 * 验证 Content-Type、大小上限、Magic Bytes。
 * 返回 undefined 表示下载失败（best-effort，不抛异常）。
 */
async function downloadViaBrowser(
  page: Page,
  imgUrl: string,
  maxBytes: number,
): Promise<{ mimeType: string; byteSize: number; sha256: string; bytes: Buffer } | undefined> {
  try {
    const response = await page.context().request.get(imgUrl, {
      maxRedirects: 5,
      timeout: 30_000,
    });

    if (!response.ok()) return undefined;

    const contentType = (response.headers()['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!ALLOWED_MIME.has(contentType)) return undefined;

    const body = await response.body();
    if (body.length === 0 || body.length > maxBytes) return undefined;

    // Magic bytes 一致性检查
    const sigMatch = MAGIC_SIGNATURES.find((s) =>
      s.prefix.every((b, idx) => body[idx] === b),
    );
    if (sigMatch === undefined) return undefined;
    if (sigMatch.mime !== contentType && contentType !== 'image/webp') {
      return undefined;
    }

    const sha256 = createHash('sha256').update(body).digest('hex');
    return { mimeType: contentType, byteSize: body.length, sha256, bytes: body };
  } catch {
    return undefined;
  }
}
