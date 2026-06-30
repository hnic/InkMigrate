/**
 * §12.6 今日头条 URL 规范化。
 *
 * 规则：
 * - 删除 Fragment。
 * - 删除已知追踪参数（utm_*、from、source、log_from、wid 等）。
 * - 保留决定内容身份的路径和 ID。
 * - 不修改图片 URL 的签名参数（p-sign.toutiaoimg.com 等域名跳过规范化）。
 */

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'from',
  'source',
  'log_from',
  'wid',
  'share_token',
  'appshare',
]);

/** 图片资源域名（不规范化签名参数）。 */
const STATIC_IMAGE_HOSTS = new Set([
  'sf1-cdn-tos.toutiaostatic.com',
  'lf3-static.bytednsdoc.com',
]);

/**
 * 判断是否为图片 CDN 域名（不规范化签名参数）。
 *
 * §I-C：Toutiao 图片 CDN 使用 p1~p30 轮换，且均带 `-sign` 签名。
 * 此前 IMAGE_HOSTS 仅硬编码 p3/p9/p26，其它 p*-sign.toutiaoimg.com 域名的
 * 签名查询串会被误删 → 403。改为按主机名后缀/正则匹配覆盖全部轮换节点。
 */
function isImageCdnHost(hostname: string): boolean {
  if (STATIC_IMAGE_HOSTS.has(hostname)) return true;
  // p*-sign.toutiaoimg.com（p1~p30 等任意轮换节点）
  return /^p\d+-sign\.toutiaoimg\.com$/.test(hostname);
}

export function canonicalizeToutiaoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // 图片域名：原样返回，不动签名
    if (isImageCdnHost(u.hostname)) return raw;
    // 删除 fragment
    u.hash = '';
    // 删除追踪参数
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    // 非 URL：原样返回（不抛错，由调用方决定）
    return raw;
  }
}

/** §12.6 priority 1：从 URL 提取今日头条内容 ID。 */
export function extractToutiaoContentId(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('toutiao.com')) return undefined;
    // §9 移动端分享短链接：m.toutiao.com/is/<digits>/ 中 token 即数字内容 ID，可直接提取。
    // 注：字母数字 token（/is/<alnum>/）编码的是重定向目标，无法静态提取。
    // resolveShortLink（见 normalize/short-link-resolver.ts）已实现该重定向跟随逻辑，
    // 但当前收藏列表 DOM 渲染的是内容原生 URL（不出现 /is/），故业务管线未接入它
    // （接入会增加有头导航开销与反爬指纹面）。若未来 DOM 出现字母数字 /is/ 短链，
    // 接入点应在 scan-driver（driveScanFavorites），而非此处静态提取器。
    const shortLinkMatch = /\/is\/(\d+)(?:\/|$)/.exec(u.pathname);
    if (shortLinkMatch) return shortLinkMatch[1];
    // /article/<id>/, /a/<id>/（新文章路径）, /wenda/<id>/, /video/<id>/, /group/<id>/, /w/<id>/（微头条）
    const m = /\/(article|a|wenda|video|group|w)\/(\d+)/.exec(u.pathname);
    return m?.[2];
  } catch {
    return undefined;
  }
}
