import { JSDOM } from 'jsdom';
import type { SourceContentKind } from '@inkmigrate/core';
import { canonicalizeToutiaoUrl, extractToutiaoContentId } from '../normalize/url.js';
import { detectContentKind } from '../normalize/content-kind.js';
import { FAVORITES_SELECTORS } from '../selectors/favorites-list.js';

export interface FavoriteItem {
  externalId?: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  author?: string;
  summary?: string;
  cover?: string;
  contentKind: SourceContentKind;
  publishedAt?: string;
  collections: string[];
  sourceMetadata: Record<string, unknown>;
}

export interface ScanInput {
  initialHtml: string;
  baseUrl: string;
  /**
   * 滚动加载更多回调。返回新的 HTML（仅新加载部分或整个列表），
   * 或 null 表示"无加载更多 / 已到底"。调用方负责真实浏览器滚动；
   * scanner 只做去重和解析。
   */
  scrollForMore: () => Promise<string | null | undefined>;
  /**
   * 连续多少轮无新条目后终止。§12.5 默认 5。调用方可覆盖。
   */
  maxEmptyCycles: number;
  /**
   * 达到多少唯一条目后立即终止（不再滚动）。用于测试或限量迁移。
   * 不传则扫描到底。
   */
  maxItems?: number;
}

/** §12.5 默认终止阈值：连续 5 次没有新条目。 */
export const DEFAULT_MAX_EMPTY_CYCLES = 5;

export interface ScanResult {
  items: FavoriteItem[];
  uniqueItems: number;
  duplicateObservations: number;
  scrollIterations: number;
  terminationReason: string;
}

/**
 * §12.4 + §12.5 收藏列表扫描。
 *
 * 不直接驱动浏览器；通过 `scrollForMore` 回调让浏览器层负责滚动。
 * scanner 维护全局唯一集合，按 externalId/canonicalUrl 去重。
 */
export async function scanFavoritesList(i: ScanInput): Promise<ScanResult> {
  const seen = new Set<string>();
  const items = new Map<string, FavoriteItem>();
  let duplicateObservations = 0;
  let scrollIterations = 0;
  let emptyCycles = 0;
  let terminationReason = 'unknown';

  let currentHtml: string | null | undefined = i.initialHtml;
  for (;;) {
    if (currentHtml === null || currentHtml === undefined) {
      terminationReason = 'no_load_more';
      break;
    }
    const observed = parseItemsFromHtml(currentHtml, i.baseUrl);
    let newInThisRound = 0;
    for (const item of observed) {
      const key = item.externalId ?? item.canonicalUrl;
      if (seen.has(key)) {
        duplicateObservations++;
        continue;
      }
      seen.add(key);
      items.set(key, item);
      newInThisRound++;
      // 达到 maxItems 立即终止，不再继续解析或滚动
      if (i.maxItems !== undefined && items.size >= i.maxItems) {
        terminationReason = `max_items_reached_${items.size}`;
        break;
      }
    }
    if (terminationReason.startsWith('max_items_reached')) break;
    if (newInThisRound === 0) {
      emptyCycles++;
      if (emptyCycles >= i.maxEmptyCycles) {
        terminationReason = `no_new_items_after_${emptyCycles}_cycles`;
        break;
      }
    } else {
      emptyCycles = 0;
    }
    scrollIterations++;
    currentHtml = await i.scrollForMore();
  }

  return {
    items: [...items.values()],
    uniqueItems: items.size,
    duplicateObservations,
    scrollIterations,
    terminationReason,
  };
}

function parseItemsFromHtml(html: string, baseUrl: string): FavoriteItem[] {
  const dom = new JSDOM(html, {
    url: baseUrl,
    runScripts: 'outside-only',
    resources: undefined,
  });
  const doc = dom.window.document;
  const out: FavoriteItem[] = [];

  const itemEls = queryFirst(doc, FAVORITES_SELECTORS.item);
  for (const el of itemEls) {
    const externalId =
      el.getAttribute(FAVORITES_SELECTORS.itemId[0]!) ?? undefined;
    const titleEls = queryFirst(el as Element, [...FAVORITES_SELECTORS.title]);
    const titleEl = titleEls[0];
    const title = titleEl?.textContent?.trim() ?? '';
    const href = titleEl?.getAttribute('href') ?? '';
    const originalUrl = resolveUrl(href, baseUrl);
    const canonicalUrl = canonicalizeToutiaoUrl(originalUrl);
    const author = textOfFirst(el as Element, FAVORITES_SELECTORS.author);
    const summary = textOfFirst(el as Element, FAVORITES_SELECTORS.summary);
    const cover =
      attrOfFirst(el as Element, FAVORITES_SELECTORS.cover, 'data-src') ??
      attrOfFirst(el as Element, FAVORITES_SELECTORS.cover, 'src');
    const contentType = textOfFirst(el as Element, FAVORITES_SELECTORS.contentType);
    const timeEls = queryFirst(el as Element, FAVORITES_SELECTORS.publishedTime);
    const timeEl = timeEls[0];
    const publishedAt =
      timeEl?.getAttribute('datetime') ?? timeEl?.textContent?.trim() ?? undefined;
    const collection = textOfFirst(el as Element, FAVORITES_SELECTORS.collectionName);

    const finalExternalId = externalId ?? extractToutiaoContentId(canonicalUrl);
    const kindInput: { url: string; hint?: string } = { url: canonicalUrl };
    if (contentType !== undefined) kindInput.hint = contentType;
    const item: FavoriteItem = {
      canonicalUrl,
      originalUrl,
      title: title || '(无标题)',
      contentKind: detectContentKind(kindInput),
      collections: collection ? [collection] : [],
      sourceMetadata: {
        contentTypeHint: contentType,
        displayCollection: collection,
      },
    };
    if (finalExternalId !== undefined) item.externalId = finalExternalId;
    if (author !== undefined) item.author = author;
    if (summary !== undefined) item.summary = summary;
    if (cover !== undefined) item.cover = resolveUrl(cover, baseUrl);
    if (publishedAt !== undefined) item.publishedAt = publishedAt;
    out.push(item);
  }
  return out;
}

function queryFirst(
  root: Element | Document,
  selectors: readonly string[],
): Element[] {
  for (const sel of selectors) {
    const els = root.querySelectorAll(sel);
    if (els.length > 0) return [...els];
  }
  return [];
}

function textOfFirst(
  root: Element,
  selectors: readonly string[],
): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const v = el?.textContent?.trim();
    if (v) return v;
  }
  return undefined;
}

function attrOfFirst(
  root: Element,
  selectors: readonly string[],
  attr: string,
): string | undefined {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    const v = el?.getAttribute(attr);
    if (v) return v;
  }
  return undefined;
}

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return baseUrl;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
