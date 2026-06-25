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
  /** 达到多少唯一条目后立即终止（不再滚动）。用于测试或限量迁移。 */
  maxItems?: number;
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

  /**
   * 增量提取：每轮只返回 DOM 中【新出现】的收藏条目 HTML。
   * 通过 window.__inkmigrate_seen Set 记录已提取过的条目 key（href），
   * 避免每轮返回全部累积条目（O(N×R) → O(N)）。
   */
  const extractItemsHtml = async (): Promise<string> => {
    return opts.page.evaluate((selectorsJson: string) => {
      const selectors = JSON.parse(selectorsJson) as string[];

      // 页面级 Set，跨多轮 evaluate 保持状态
      const w = window as unknown as { __inkmigrate_seen?: Set<string> };
      if (w.__inkmigrate_seen === undefined) {
        w.__inkmigrate_seen = new Set<string>();
      }
      const seen = w.__inkmigrate_seen;

      // 找到第一个匹配的条目选择器
      let allEls: Element[] = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          allEls = Array.from(found);
          break;
        }
      }

      // 只收集本轮新出现的条目
      const newEls: Element[] = [];
      for (const el of allEls) {
        // 提取条目的唯一 key（内容链接的 href）
        const link = el.querySelector(
          'a[href*="/article/"], a[href*="/video/"], a[href*="/wenda/"], a[href*="/group/"]',
        );
        const href = link?.getAttribute('href');
        if (href !== null && href !== undefined) {
          if (!seen.has(href)) {
            seen.add(href);
            newEls.push(el);
          }
        } else {
          // 没有 href 的条目（fallback），用文本内容 hash 作为 key
          const textKey = el.textContent?.trim().substring(0, 100) ?? '';
          if (textKey && !seen.has(textKey)) {
            seen.add(textKey);
            newEls.push(el);
          }
        }
      }

      // 包裹在一个 div 里
      const wrapper = document.createElement('div');
      for (const el of newEls) wrapper.appendChild(el.cloneNode(true));
      return wrapper.innerHTML;
    }, JSON.stringify(FAVORITES_SELECTORS.item));
  };

  const initialHtml = await extractItemsHtml();
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

    return extractItemsHtml();
  };

  const scanInput: Parameters<typeof scanFavoritesList>[0] = {
    initialHtml,
    baseUrl: opts.baseUrl,
    scrollForMore,
    maxEmptyCycles: opts.maxEmptyCycles ?? DEFAULT_MAX_EMPTY_CYCLES,
  };
  if (opts.maxItems !== undefined) {
    scanInput.maxItems = opts.maxItems;
  }
  const scanResult = await scanFavoritesList(scanInput);

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
