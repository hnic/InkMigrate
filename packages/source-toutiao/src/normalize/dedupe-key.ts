import {
  canonicalizeToutiaoUrl,
  extractToutiaoContentId,
} from './url.js';

/**
 * §缺陷3 统一去重 key 派生的**参考实现**。
 *
 * Node 端 scanner 的 key = `finalExternalId ?? canonicalUrl`，其中
 *   finalExternalId = 容器 data-item-id ?? extractToutiaoContentId(canonicalUrl)
 *   canonicalUrl = canonicalizeToutiaoUrl(originalUrl)
 *
 * 注意：浏览器侧（scan-driver 的 page.evaluate）携带自己的内联副本（注释要求
 * "修改时务必同步两处"），并未 import 本函数——本模块是口径文档 + 单测锚点，
 * 不是运行时的单一事实来源；改此口径必须同步改 scan-driver 的内联副本与
 * scanner.parseItemsFromHtml。
 *
 * 要求纯函数、不依赖任何 Node 内置模块，以便被序列化注入到页面上下文执行。
 *
 * @param href 元素链接的原始 href（可能含 query/fragment/追踪参数/相对路径）
 * @param baseUrl 用于解析相对 href 的基址（通常 https://www.toutiao.com/）
 * @param externalIdFromDom 条目容器的 data-item-id（scanner 的第一优先级；
 *   缺省时与 URL 派生兜底等价）
 * @returns 与 Node 端 scanner 等价的稳定去重 key
 */
export function deriveDedupeKey(
  href: string,
  baseUrl: string,
  externalIdFromDom?: string,
): string {
  // 空/纯空白 href 不应折叠到 baseUrl 同一 key（new URL('', base) 会解析成
  // baseUrl 本身，所有无链接条目会被误判为同一条）。此处显式报错由调用方
  // 决定跳过或合成唯一 key——scanner.resolveUrl 与浏览器内联副本需同步同口径。
  if (href.trim().length === 0) {
    throw new Error(`deriveDedupeKey: empty href (baseUrl=${baseUrl})`);
  }
  // 解析相对路径到绝对（与 scanner.parseItemsFromHtml 的 resolveUrl 一致）
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(href, baseUrl).toString();
  } catch {
    absoluteUrl = href;
  }
  const canonicalUrl = canonicalizeToutiaoUrl(absoluteUrl);
  // 优先级与 scanner 一致：DOM data-item-id 优先，URL 派生 ID 兜底
  const externalId = externalIdFromDom ?? extractToutiaoContentId(canonicalUrl);
  return externalId ?? canonicalUrl;
}
