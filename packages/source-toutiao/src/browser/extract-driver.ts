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

  try {
    await opts.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navigationTimeoutMs ?? 60_000,
    });
    // 等正文容器出现（不等所有网络请求完成）
    await opts.page.waitForSelector('article, .article-content, .post-content, body', {
      timeout: 10_000,
    }).catch(() => {});
  } catch (e) {
    // 包装 Playwright 导航错误，附带 retryable 标志
    // 让 job-runner catch 块能正确分类为永久失败（不卡在同一条上反复超时）
    const msg = e instanceof Error ? e.message : String(e);
    const wrapped = new Error(`navigation failed for ${url}: ${msg}`) as Error & {
      retryable: false;
      code: string;
      itemDisposition: string;
    };
    wrapped.retryable = false;
    wrapped.code = msg.includes('Timeout') || msg.includes('timeout')
      ? 'NAVIGATION_TIMEOUT'
      : 'NAVIGATION_FAILED';
    wrapped.itemDisposition = 'permanent_failed';
    throw wrapped;
  }

  const html = await opts.page.content();
  const detail = extractDetail({
    html,
    canonicalUrl: url,
    originalUrl: opts.ref.originalUrl ?? url,
  });

  // §12.10 best-effort 图片下载
  // 默认上限与 ToutiaoSourceConfigSchema.maxImageBytes 一致（50MB），避免两份默认值漂移
  //（此前此处硬编码 150MB，config 的 50MB 形同虚设——因 adapter 仅在显式传值时透传）。
  const maxBytes = opts.maxImageBytes ?? 50 * 1024 * 1024;
  // 有界并发下载：图集页常有数十张图，串行下载耗时数倍。并发度限制为 3，
  // 平衡吞吐与内存（每张图字节短暂驻留 asset.data，并发过高易 OOM）。
  const IMAGE_DOWNLOAD_CONCURRENCY = 3;
  const assets: SourceAsset[] = await mapWithConcurrency(
    detail.images,
    IMAGE_DOWNLOAD_CONCURRENCY,
    async (imgUrl: string): Promise<SourceAsset> => {
      const asset: SourceAsset = { originalUrl: imgUrl, kind: 'image' };
      const dl = await downloadImage({ url: imgUrl, maxBytes, referer: url });
      if (dl.ok) {
        const sha256 = createHash('sha256').update(dl.bytes).digest('hex');
        asset.mimeType = dl.mimeType;
        asset.byteSize = dl.byteSize;
        asset.sha256 = `sha256:${sha256}`;
        // 瞬态保留字节，供下游 target adapter 写入本地附件。字节随 SourceItem
        // 在 processOneItem 内同步流转（extract→plan→write），不跨进程/持久化。
        asset.data = dl.bytes;
      }
      return asset;
    },
  );

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
 * 有界并发 map：最多 `concurrency` 个 mapper 同时运行，结果按原数组顺序返回。
 * 不引入 p-limit 依赖，用简单的"游标 + 活跃计数"实现。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await mapper(items[idx]!, idx);
    }
  }
  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
