import {
  canonicalizeToutiaoUrl,
  extractToutiaoContentId,
} from './url.js';

/**
 * §缺陷3 统一去重 key 派生：浏览器端 (`scan-driver`) 与 Node 端 (`scanner`)
 * 必须用**同口径**的 key，否则同一收藏项因 href 中 query/追踪参数差异，
 * 会被浏览器端判为"新条目"传回 Node，再被 Node 端归一化去重丢弃 → 本轮
 * newInThisRound=0 → 连续多轮触发 emptyCycles>=5 提前终止（扫描尚未到底）。
 *
 * Node 端 scanner 的 key = `externalId ?? canonicalUrl`，其中
 *   externalId = extractToutiaoContentId(canonicalUrl)
 *   canonicalUrl = canonicalizeToutiaoUrl(originalUrl)
 *
 * 本函数在浏览器侧（`page.evaluate` 内）复现这一口径。要求纯函数、
 * 不依赖任何 Node 内置模块，以便被序列化注入到页面上下文执行。
 *
 * @param href 元素链接的原始 href（可能含 query/fragment/追踪参数/相对路径）
 * @param baseUrl 用于解析相对 href 的基址（通常 https://www.toutiao.com/）
 * @returns 与 Node 端 scanner 等价的稳定去重 key
 */
export function deriveDedupeKey(href: string, baseUrl: string): string {
  // 解析相对路径到绝对（与 scanner.parseItemsFromHtml 的 resolveUrl 一致）
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(href, baseUrl).toString();
  } catch {
    absoluteUrl = href;
  }
  const canonicalUrl = canonicalizeToutiaoUrl(absoluteUrl);
  const externalId = extractToutiaoContentId(canonicalUrl);
  return externalId ?? canonicalUrl;
}
