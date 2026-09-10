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
  /** 取消检查回调（可选）。主循环每轮检查，返回 true 时终止扫描。 */
  isCancelled?: () => boolean;
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
    // 取消检查（GUI 终止按钮）：在处理新一轮前退出
    if (i.isCancelled?.()) {
      terminationReason = 'cancelled';
      break;
    }
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
    try {
      currentHtml = await i.scrollForMore();
    } catch (err) {
      // 浏览器层瞬时故障（导航/CDP 超时）：返回已累积的部分结果并给出可诊断
      // 终止原因，而不是整体抛错丢弃数百条已扫描收藏
      terminationReason = `scroll_error:${(err as Error)?.message ?? 'unknown'}`;
      break;
    }
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

  // 合并所有条目选择器的并集去重——同页混合视频/文章/微头条，外层 class 不同，
  // 取第一个非空选择器会漏掉其它类型（与 scan-driver extractItemsHtml 同理）
  const itemEls = queryAll(doc, FAVORITES_SELECTORS.item);
  for (const el of itemEls) {
    // 非空守卫：选择器数组被清空/重构时，getAttribute(undefined) 会把属性名
    // 强转成字面 "undefined" 静默返回 null，去重行为无声改变
    const itemIdAttr = FAVORITES_SELECTORS.itemId[0];
    const externalId = itemIdAttr !== undefined
      ? el.getAttribute(itemIdAttr) ?? undefined
      : undefined;
    const titleEls = queryFirst(el as Element, [...FAVORITES_SELECTORS.title]);
    let titleEl = titleEls[0];
    // 视频条目的内容链接在 .feed-card-cover > a，无 .title class，title 选择器组命中不到。
    // 兜底：直接找条目内的内容链接（与 scan-driver extractItemsHtml 同口径）。
    if (titleEl === undefined) {
      titleEl = (el as Element).querySelector(FAVORITES_SELECTORS.contentLink) ?? undefined;
    }
    // 标题：优先文本节点；视频条目标题在 a 的 title 属性里（非文本节点）
    const title =
      titleEl?.textContent?.trim() ||
      titleEl?.getAttribute('title')?.trim() ||
      '';
    const href = titleEl?.getAttribute('href') ?? '';
    if (!href) {
      // 无内容链接的条目解析不出真实 URL：跳过而不是把列表页当内容页
      // （否则 originalUrl=列表页 → contentKind 误判 + 去重键全撞同一条）
      continue;
    }
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
    // 空串与空白归一为 undefined：'' 会通过后续 !== undefined 守卫落库，
    // 污染 R4-M4 月份分片（"未知日期"之外再添一个空日期桶）
    const publishedAt =
      timeEl?.getAttribute('datetime')?.trim() || timeEl?.textContent?.trim() || undefined;
    const collection = textOfFirst(el as Element, FAVORITES_SELECTORS.collectionName);

    // URL 派生的内容 ID 跨轮次/跨 DOM 形态稳定；data-item-id 仅在 URL 提取不到
    // 时兜底——同一内容因"有无 DOM 属性"在两轮里生成不同去重键会被重复计数
    const finalExternalId = extractToutiaoContentId(canonicalUrl) ?? externalId;
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
        // R4-M4: 存入 publishedAt 供索引 month 分片使用（原不存，导致所有笔记落入"未知日期"）
        ...(publishedAt !== undefined ? { publishedAt } : {}),
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

/**
 * 合并【所有】选择器的并集去重。用于条目容器——同一页面混合多种类型
 * （视频/文章/微头条），每种外层 class 不同，必须全部抓取。
 * 对比 queryFirst（取第一个非空）只适用于单元素内的字段查找。
 */
function queryAll(
  root: Element | Document,
  selectors: readonly string[],
): Element[] {
  const seen = new Set<Element>();
  for (const sel of selectors) {
    for (const el of root.querySelectorAll(sel)) seen.add(el);
  }
  return [...seen];
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
