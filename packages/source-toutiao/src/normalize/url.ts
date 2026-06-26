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
const IMAGE_HOSTS = new Set([
  'p3-sign.toutiaoimg.com',
  'p9-sign.toutiaoimg.com',
  'p26-sign.toutiaoimg.com',
  'sf1-cdn-tos.toutiaostatic.com',
  'lf3-static.bytednsdoc.com',
]);

export function canonicalizeToutiaoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // 图片域名：原样返回，不动签名
    if (IMAGE_HOSTS.has(u.hostname)) return raw;
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
    // /article/<id>/, /wenda/<id>/, /video/<id>/, /group/<id>/, /w/<id>/（微头条）
    const m = /\/(article|wenda|video|group|w)\/(\d+)/.exec(u.pathname);
    return m?.[2];
  } catch {
    return undefined;
  }
}
