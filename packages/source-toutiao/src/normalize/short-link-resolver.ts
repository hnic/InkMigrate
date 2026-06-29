import type { Page } from 'playwright';

/**
 * §9 移动端分享短链接解析。
 *
 * 头条移动端分享 URL 形如 `m.toutiao.com/is/<token>/`。其中：
 * - 数字 token：token 即内容 ID，`extractToutiaoContentId` 已能静态提取，无需此解析器。
 * - 字母数字 token：编码的是重定向目标，需跟随 HTTP 重定向拿到内容原生 URL
 *   （/article/<id>/ 等），再用 `extractToutiaoContentId` 提取 ID。
 *
 * 本解析器复用扫描已有的 **有头** Playwright 页面（headless fetch 会被头条反爬拦截，
 * 见 browser-session 的反爬说明）。命中 /is/<非纯数字 token>/ 时导航该页面，
 * 读 `page.url()` 取重定向后的最终 URL，命中 /is/<纯数字>/ 或非 /is/ 则原样返回。
 *
 * 进程内缓存：同一次扫描内同一 /is/ token 不重复解析（Map，key=完整短链 URL）。
 * 不持久化——扫描是一次性的，跨进程无需共享。
 *
 * 反爬/性能权衡：解析会新增一次导航（慢、增加指纹面）。因此仅在被确认为字母数字
 * token 的 /is/ 短链时触发；当前收藏列表 DOM 渲染的是内容原生 URL（不出现 /is/），
 * 此解析器主要作为防御性加固，应对未来 DOM 变化。
 */

const IS_SHORT_LINK_RE = /^https?:\/\/[^/]*\/is\/([^/?#]+)/i;

/** 判断 URL 是否为需要重定向解析的字母数字 /is/ 短链（纯数字 token 可静态提取，无需解析）。 */
export function needsShortLinkResolution(url: string): boolean {
  const m = IS_SHORT_LINK_RE.exec(url);
  if (m === null) return false;
  const token = m[1]!;
  return !/^\d+$/.test(token);
}

export interface ResolveShortLinkOptions {
  /** 已导航的 Playwright 页面（复用扫描的 headed 页面）。 */
  page: Page;
  /** 导航超时毫秒（默认 15s）。 */
  navigationTimeoutMs?: number;
  /** 可注入的缓存（默认新建进程内 Map）。测试可注入空 Map 复用。 */
  cache?: Map<string, string>;
}

/**
 * 若 url 是字母数字 /is/ 短链，导航并返回重定向后的最终 URL；否则原样返回。
 * 缓存命中直接返回，不重复导航。
 */
export async function resolveShortLink(
  url: string,
  opts: ResolveShortLinkOptions,
): Promise<string> {
  if (!needsShortLinkResolution(url)) return url;
  const cache = opts.cache ?? new Map<string, string>();
  const cached = cache.get(url);
  if (cached !== undefined) return cached;

  let resolved = url;
  try {
    await opts.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navigationTimeoutMs ?? 15_000,
    });
    const finalUrl = opts.page.url();
    // 仅当重定向到了一个不同于原 /is/ 的 URL 才算解析成功
    if (finalUrl !== url && !IS_SHORT_LINK_RE.test(finalUrl)) {
      resolved = finalUrl;
    }
  } catch {
    // 导航失败（超时/反爬）：保留原 URL，调用方按既有 fallback 处理
    resolved = url;
  }
  cache.set(url, resolved);
  return resolved;
}
