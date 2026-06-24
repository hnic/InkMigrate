import type { Page } from 'playwright';
import {
  scanFavoritesList,
  DEFAULT_MAX_EMPTY_CYCLES,
  type FavoriteItem,
  type ScanResult,
} from '../scan/scanner.js';
import { deriveFingerprintInput } from '../normalize/fingerprint.js';
import { computeFingerprint, type SourceItemRef } from '@inkmigrate/core';
import { FAVORITES_SELECTORS } from '../selectors/favorites-list.js';

export interface ScanDriverOptions {
  page: Page;
  /** 收藏列表页面 URL。 */
  favoritesUrl: string;
  /** 用于 URL 解析的 baseUrl，通常 https://www.toutiao.com/ */
  baseUrl: string;
  /** 来源实例 ID（用于构造 SourceItemRef）。 */
  sourceInstanceId: string;
  /** 连续多少轮无新条目后终止（§12.5 默认 5）。 */
  maxEmptyCycles?: number;
  /** 每次滚动后等待页面稳定的毫秒数（§12.5）。 */
  waitAfterScrollMs?: number;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
}

export interface ScanDriverResult {
  refs: SourceItemRef[];
  /** scanFavoritesList 返回的完整扫描统计。 */
  scanResult: ScanResult;
}

/**
 * §12.4 + §12.5 浏览器驱动的收藏列表扫描。
 *
 * 流程：
 * 1. 导航到 favoritesUrl，等待 networkidle。
 * 2. 获取初始 HTML，交给 scanFavoritesList 解析。
 * 3. scrollForMore 回调：滚动到底部 → 等待 → 尝试点击"加载更多" → 返回新 HTML。
 * 4. scanner 负责去重和终止判断。
 * 5. 把 FavoriteItem 列表转为 SourceItemRef。
 *
 * 本函数只做浏览器编排（滚动、等待、点击），解析和去重由纯逻辑 scanner 完成。
 * buildRefFromFavorite 逻辑内联在此处，避免与 adapters/adapter.ts 形成循环依赖
 * （adapter.ts 导入本模块的 driveScanFavorites）。
 */
export async function driveScanFavorites(
  opts: ScanDriverOptions,
): Promise<ScanDriverResult> {
  await opts.page.goto(opts.favoritesUrl, {
    waitUntil: 'networkidle',
    timeout: opts.navigationTimeoutMs ?? 45_000,
  });

  const initialHtml = await opts.page.content();
  const waitMs = opts.waitAfterScrollMs ?? 1500;

  const scrollForMore = async (): Promise<string | null> => {
    // §12.5 滚动到底部
    await opts.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await opts.page.waitForTimeout(waitMs);

    // §12.5 尝试点击"加载更多"按钮（如果可见）
    const loadMoreSelectors = FAVORITES_SELECTORS.loadMore;
    for (const sel of loadMoreSelectors) {
      const locator = opts.page.locator(sel).first();
      const visible = await locator.isVisible().catch(() => false);
      if (visible) {
        await locator.click({ timeout: 2000 }).catch(() => {});
        await opts.page.waitForTimeout(waitMs);
        break;
      }
    }

    return opts.page.content();
  };

  const scanResult = await scanFavoritesList({
    initialHtml,
    baseUrl: opts.baseUrl,
    scrollForMore,
    maxEmptyCycles: opts.maxEmptyCycles ?? DEFAULT_MAX_EMPTY_CYCLES,
  });

  const discoveredAt = new Date().toISOString();
  const refs: SourceItemRef[] = scanResult.items.map((fav) =>
    buildRefInline(opts.sourceInstanceId, fav, discoveredAt),
  );

  return { refs, scanResult };
}

/**
 * 从 FavoriteItem 构造 SourceItemRef。与 adapters/adapter.ts 中的 buildRefFromFavorite
 * 逻辑相同，内联在此处以避免循环依赖。
 */
function buildRefInline(
  sourceInstanceId: string,
  favorite: FavoriteItem,
  discoveredAt: string,
): SourceItemRef {
  const fpInputBuilder: Parameters<typeof deriveFingerprintInput>[0] = {
    canonicalUrl: favorite.canonicalUrl,
    title: favorite.title,
    originalUrl: favorite.originalUrl,
  };
  if (favorite.externalId !== undefined) fpInputBuilder.contentId = favorite.externalId;
  if (favorite.publishedAt !== undefined) fpInputBuilder.publishedAt = favorite.publishedAt;
  const fpInput = deriveFingerprintInput(fpInputBuilder);
  const fingerprint = computeFingerprint(fpInput);
  const ref: SourceItemRef = {
    sourceInstanceId,
    canonicalUrl: favorite.canonicalUrl,
    originalUrl: favorite.originalUrl,
    title: favorite.title,
    contentKind: favorite.contentKind,
    discoveredAt,
    fingerprint,
    sourceMetadata: favorite.sourceMetadata,
  };
  if (favorite.externalId !== undefined) ref.externalId = favorite.externalId;
  return ref;
}
