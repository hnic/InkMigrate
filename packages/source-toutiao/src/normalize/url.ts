/**
 * §12.6 今日头条 URL 规范化。
 *
 * 规则：
 * - 仅处理 http(s) 的头条域名（toutiao.com 及其子域），其它 URL 原样返回。
 * - 删除 Fragment。
 * - 删除已知追踪参数（utm_*、from、source、log_from、wid 等，键名不区分大小写）。
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

/** 判断是否为头条域名：精确匹配 apex 或其子域。 */
function isToutiaoHost(hostname: string): boolean {
  return hostname === 'toutiao.com' || hostname.endsWith('.toutiao.com');
}

export function canonicalizeToutiaoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // 非 http(s)（如 javascript:）不动：规范化只面向网页 URL。
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    // 图片域名：原样返回，不动签名（纵深防御——当前全部图片 CDN 域名都不是
    // *.toutiao.com，理论上会命中下方"非头条域名原样返回"；保留显式分支是为
    // 防未来出现头条域下的带签名图片域时被误剥参，非冗余死代码）
    if (isImageCdnHost(u.hostname)) return raw;
    // 仅头条域名按头条口径剥参：头条 DOM 可能含第三方链接，from/source/wid
    // 在其它站点可能是功能性参数而非追踪参数，误剥会悄悄破坏那些链接
    if (!isToutiaoHost(u.hostname)) return raw;
    // 删除 fragment
    u.hash = '';
    // 删除追踪参数（URLSearchParams 保留键名大小写，From=/UTM_Source= 等
    // 变体需小写后比对，否则躲过去重）。utm_* 按前缀通配：文件头口径是
    // "utm_* …"，仅枚举 5 个键会漏掉 utm_id/utm_referrer 等变体
    for (const key of [...u.searchParams.keys()]) {
      const k = key.toLowerCase();
      if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) u.searchParams.delete(key);
    }
    // 参数排序：同一内容不同参数顺序（?a=1&b=2 vs ?b=2&a=1）归一到同一
    // canonical 形式，否则 URL 兜底去重键会漏合并。注意 u.toString() 还会
    // 重编码（%20→+ 等），canonical 输出只能与其它 canonical 输出比较
    u.searchParams.sort();
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
    // 域名匹配用带前导点的 endsWith('.toutiao.com')（见 isToutiaoHost）：既能命中
    // 全部子域，又能挡住 eviltoutiao.com 这类仿冒域名——否则其 /article/<id>/
    // 路径会被当成头条内容 ID，污染去重键
    if (!isToutiaoHost(u.hostname)) return undefined;
    // §9 移动端分享短链接：m.toutiao.com/is/<digits>/ 中 token 即数字内容 ID，可直接提取。
    // 注：字母数字 token（/is/<alnum>/）编码的是重定向目标，无法静态提取。
    // resolveShortLink（见 normalize/short-link-resolver.ts）已实现该重定向跟随逻辑，
    // 但当前收藏列表 DOM 渲染的是内容原生 URL（不出现 /is/），故业务管线未接入它
    // （接入会增加有头导航开销与反爬指纹面）。若未来 DOM 出现字母数字 /is/ 短链，
    // 接入点应在 scan-driver（driveScanFavorites），而非此处静态提取器。
    const shortLinkMatch = /\/is\/(\d+)(?:\/|$)/.exec(u.pathname);
    if (shortLinkMatch) return shortLinkMatch[1];
    // /article/<id>/, /a/<id>/（新文章路径）, /wenda/<id>/, /video/<id>/, /group/<id>/, /w/<id>/（微头条）
    // 锚定路径开头并以段边界收尾，避免 '/xxx/w/123' 这类非内容路径的深层子路径误命中
    const m = /^\/(?:article|a|wenda|video|group|w)\/(\d+)(?:\/|$)/.exec(u.pathname);
    return m?.[1];
  } catch {
    return undefined;
  }
}
