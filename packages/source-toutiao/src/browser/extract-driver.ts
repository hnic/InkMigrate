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
import { ToutiaoSourceConfigSchema } from '../config.js';

/** 默认单图上限：单源取自 ToutiaoSourceConfigSchema.maxImageBytes 的 zod default。 */
const DEFAULT_MAX_IMAGE_BYTES = ToutiaoSourceConfigSchema.shape.maxImageBytes.parse(
  undefined,
);

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
 * 1. 导航到 ref.canonicalUrl（waitUntil: 'domcontentloaded'，不等待 networkidle），
 *    随后 best-effort 等待正文容器出现（超时降级继续）。
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
    // 等正文容器出现（不等所有网络请求完成）；超时则降级继续。
    // 不把 body 放进 selector：body 在 domcontentloaded 后必然存在，
    // 会让等待立即返回、形同虚设
    await opts.page.waitForSelector('article, .article-content, .post-content', {
      timeout: 10_000,
    }).catch(() => {});
  } catch (e) {
    // 包装 Playwright 导航错误，附带 retryable 标志：
    // - 瞬时网络类错误（DNS 解析失败、连接被重置、net::ERR_TIMED_OUT 等）标记
    //   retryable=true，交给 withRetry 的有界重试（§18.1，最多 3 次）恢复偶发
    //   网络抖动，避免条目被静默永久丢弃；
    // - 其余（导航超时、ERR_ABORTED 等）保持 retryable=false——实测超时页重试
    //   大概率继续超时，会卡住批次（这正是引入该标记的原因），由 job-runner
    //   归为永久失败，resume 时跳过
    const msg = e instanceof Error ? e.message : String(e);
    const TRANSIENT_NAV_ERROR =
      /ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|ERR_SOCKET|ECONNRESET|EAI_AGAIN|socket hang up/;
    const isTransient = TRANSIENT_NAV_ERROR.test(msg);
    const wrapped = new Error(`navigation failed for ${url}: ${msg}`) as Error & {
      retryable: boolean;
      code: string;
      itemDisposition: string;
    };
    wrapped.retryable = isTransient;
    wrapped.code = msg.includes('Timeout') || msg.includes('timeout')
      ? 'NAVIGATION_TIMEOUT'
      : isTransient
        ? 'NAVIGATION_TRANSIENT_NETWORK'
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

  // 先做廉价的同步契约校验（违反会 throw），再进入昂贵的图片下载，
  // 避免校验失败时已白白下载全部图片
  validateSourceItemQuality(detail.quality, detail.degradations);

  // §12.10 best-effort 图片下载
  // 单图上限默认值单源取自 ToutiaoSourceConfigSchema.maxImageBytes（zod default），
  // 不再手写字面量，避免与 config 默认值漂移（adapter 仅在显式配置时透传）。
  const maxBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
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
