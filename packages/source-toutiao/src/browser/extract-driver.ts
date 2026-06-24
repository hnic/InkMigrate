import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import {
  type SourceAsset,
  type SourceItem,
  type SourceItemRef,
  validateSourceItemQuality,
} from '@inkmigrate/core';
import { extractDetail } from '../extract/detail-extractor.js';
import { downloadImage } from '../assets/image-downloader.js';

export interface ExtractDriverOptions {
  page: Page;
  ref: SourceItemRef;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
  /** §12.10 单张图片大小上限。 */
  maxImageBytes?: number;
}

/**
 * §12.8 浏览器驱动的详情页提取。
 *
 * 流程：
 * 1. 导航到 ref.canonicalUrl，等待 networkidle。
 * 2. 获取页面 HTML，交给 extractDetail（结构化数据 + readability + 安全流水线）。
 * 3. 对 detail.images 中的每张图片尝试 downloadImage（best-effort）。
 *    - 下载成功：asset 带 sha256/byteSize/mimeType。
 *    - 下载失败：asset 仅保留 originalUrl（metadata-only），不影响 quality。
 * 4. 返回完整 SourceItem。
 *
 * Readability 在 extractDetail 内部对独立 jsdom 克隆运行，不修改 Playwright 页面（§12.8）。
 * 图片下载使用 Node.js fetch（非浏览器上下文），适用于 CDN 公开图片（§12.10）。
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

  // §12.10 best-effort 图片下载
  const maxBytes = opts.maxImageBytes ?? 50 * 1024 * 1024;
  const assets: SourceAsset[] = [];
  for (const imgUrl of detail.images) {
    const asset: SourceAsset = { originalUrl: imgUrl, kind: 'image' };
    const dl = await downloadImage({ url: imgUrl, maxBytes, referer: url });
    if (dl.ok) {
      const sha256 = createHash('sha256').update(dl.bytes).digest('hex');
      asset.mimeType = dl.mimeType;
      asset.byteSize = dl.byteSize;
      asset.sha256 = `sha256:${sha256}`;
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
