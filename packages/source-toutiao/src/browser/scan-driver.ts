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
  /** 每轮滚动后的进度回调。 */
  onProgress?: (info: { found: number; scrollRound: number; phase: string }) => void;
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
    waitUntil: 'domcontentloaded',
    timeout: opts.navigationTimeoutMs ?? 30_000,
  });

  /**
   * 增量提取：每轮只返回 DOM 中【新出现】的收藏条目 HTML。
   * Node 端维护 seen Set，每次 evaluate 传入已知的 key 列表，
   * 浏览器端只返回未在 knownKeys 中的条目。
   * 避免 window 全局变量在页面刷新时丢失的风险。
   */
  const nodeSeen = new Set<string>();
  const extractItemsHtml = async (): Promise<string> => {
    const knownKeys = Array.from(nodeSeen);
    const result = await opts.page.evaluate(
      (params: { selectorsJson: string; knownJson: string }) => {
        const selectors = JSON.parse(params.selectorsJson) as string[];
        const known = new Set(JSON.parse(params.knownJson) as string[]);

        // 找到第一个匹配的条目选择器
        let allEls: Element[] = [];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > 0) {
            allEls = Array.from(found);
            break;
          }
        }

        // 收集本轮新出现的条目 + 它们的 key
        const newEls: Element[] = [];
        const newKeys: string[] = [];
        for (const el of allEls) {
          const link = el.querySelector(
            'a[href*="/article/"], a[href*="/video/"], a[href*="/wenda/"], a[href*="/group/"]',
          );
          const href = link?.getAttribute('href');
          let key: string | undefined;
          if (href !== null && href !== undefined) {
            key = href;
          } else {
            const textKey = el.textContent?.trim().substring(0, 100) ?? '';
            if (textKey) key = textKey;
          }
          if (key !== undefined && !known.has(key)) {
            newEls.push(el);
            newKeys.push(key);
          }
        }

        const wrapper = document.createElement('div');
        for (const el of newEls) wrapper.appendChild(el.cloneNode(true));
        return { html: wrapper.innerHTML, newKeys };
      },
      { selectorsJson: JSON.stringify(FAVORITES_SELECTORS.item), knownJson: JSON.stringify(knownKeys) },
    );
    // 在 Node 端更新 seen（页面刷新不会丢失）
    for (const k of result.newKeys) {
      nodeSeen.add(k);
    }
    return result.html;
  };

  const initialHtml = await extractItemsHtml();
  const waitMs = opts.waitAfterScrollMs ?? 1500;
  let scrollRound = 0;

  const scrollForMore = async (): Promise<string | null> => {
    scrollRound++;
    // 进度通知：开始滚动
    if (opts.onProgress !== undefined) {
      opts.onProgress({ found: nodeSeen.size, scrollRound, phase: 'scrolling' });
    }

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

    const html = await extractItemsHtml();

    // 进度通知：本轮滚动完成
    if (opts.onProgress !== undefined) {
      opts.onProgress({ found: nodeSeen.size, scrollRound, phase: 'loaded' });
    }

    return html;
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
