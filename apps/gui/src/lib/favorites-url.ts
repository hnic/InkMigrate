/**
 * GUI 侧收藏页 URL 规范化与发送前校验。
 *
 * 引擎 schema 在信任边界强制 ^https?://（file:/javascript: 等杂值必须拒绝，见
 * apps/engine/src/schemas.ts 的 favoritesUrlRequired）。但用户手工粘贴的两种
 * 常见形态会直接死于 -32602「favoritesUrl 必须是 http(s) URL」：
 *   - 从 Chrome 地址栏复制纯文本时协议头被剥（得到 www.toutiao.com/...?tab=fav）；
 *   - 粘贴带首尾空白/换行/零宽字符（ConfigPrompt 用的是多行 textarea）。
 * 规范化只处理这两类「意图明确」的形态；无法救回的值原样返回，由发送侧用
 * isSendableFavoritesUrl 给出可读的客户端错误，而非裸 RPC 校验错。
 */

/** 剥离粘贴常见噪声后规范化：取首个非空行 + 去空白/零宽字符 + 补缺失协议头。 */
export function normalizeFavoritesUrl(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  let cleaned = firstLine.replace(/[\u200B\u200C\u200D\uFEFF]/g, '');
  if (cleaned === '') return '';
  if (/^https?:\/\//i.test(cleaned)) {
    // 已带协议：先过头条畸形 query 自愈再返回
    return repairToutiaoFavQuery(cleaned);
  }
  // 缺协议头的域名形态（www.toutiao.com/... 或 toutiao.com/...）：补 https://
  if (/^(www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[:/?#]|$)/i.test(cleaned)) {
    return repairToutiaoFavQuery(`https://${cleaned}`);
  }
  return cleaned;
}

/**
 * 头条 2026-09 页头「我的收藏」链接的参数分隔符是 ? 而非 &（?tab=fav?source=feed），
 * 站内 SPA 点击能容错，但整页导航时 tab 参数值不被识别、收藏页落在默认 tab 扫出
 * 0 条（2026-09-11 真实 Profile 实测）。已按原样存进设置的坏值在此自愈：仅对
 * 头条 token 形态收藏 URL 修复，避免误伤其它来源的粘贴值。引擎侧提取
 * （login-flow extractFavoritesUrl）已做同一修复，此处兜底存量值。
 */
function repairToutiaoFavQuery(url: string): string {
  const m = /^(https?:\/\/[^/]*toutiao\.com\/c\/user\/token\/[^?#]+)(\?[^#]*)(#.*)?$/i.exec(url);
  if (!m) return url;
  // query 首字符是 ?（分隔符），其后的 ? 全部还原为 &（参数分隔符的正确形态）
  const query = m[2]!.replace(/\?/g, (c, i: number) => (i === 0 ? c : '&'));
  return m[1]! + query + (m[3] ?? '');
}

/** 规范化后的值是否是引擎可接受的 http(s) URL（发送前客户端校验）。 */
export function isSendableFavoritesUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}
