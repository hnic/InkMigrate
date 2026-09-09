/**
 * §13.6 安全的 HTML 实体解码。
 *
 * 背景：HTML→Markdown 流水线中，HTML 被多次 `innerHTML` 序列化，属性值里的
 * `"` 会被重新编码为 `&quot;`，最终漏进 Markdown 正文和文件名。本工具负责
 * 把这些泄漏的实体还原成真实字符。
 *
 * **安全边界**：只解码在 Markdown/文件名语境下无害的实体。
 *
 * 不解码 `&lt;` / `&gt;` —— 解码它们会把 `<b>`、`<script>` 等伪 HTML 重新放回
 * 文本，绕过上游的 HTML Sanitization（§12.9 stage 5）。若需呈现尖括号，应在
 * 上游用 `&amp;lt;` 双重编码，本函数只解码一层。
 *
 * 顺序很重要：必须先解码命名/数字实体，最后再解码 `&amp;`，否则会出现二次解码
 * （例如 `&amp;quot;` 应解出 `&quot;` 而非 `"`）。本实现用单次正则替换并显式
 * 处理 `&amp;`，天然避免二次解码。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  amp: '&', // 放在这里但通过单次替换处理，不会二次解码
  apos: "'",
  // 有意压平为普通空格而非保留 U+00A0：输出中出现不可见的不换行空格会在终端/
  // 同步工具/后续空白处理中造成歧义；该行为由测试固定。
  nbsp: ' ',
  '#39': "'",
};

// 从白名单派生正则：分支与 map 键由同一数据源生成，结构上不可能漂移
//（新增实体只需改上表；也绝不会意外长出 lt/gt 分支绕过上游 sanitization）。
const ENTITY_RE = new RegExp(`&(${Object.keys(NAMED_ENTITIES).join('|')});`, 'g');

/**
 * 解码有限的、安全的 HTML 实体子集。
 *
 * 单次扫描，每个匹配独立替换 —— `&amp;quot;` 中的 `&amp;` 命中后变为 `&`，
 * 剩余 `quot;` 不再被扫描，因此输出为 `&quot;`（正确：原义就是字面 `&quot;`）。
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(ENTITY_RE, (m, name: string) => {
    // 防御性兜底：正则已从白名单派生，正常不会缺键；若未来出现漂移，
    // 原样返回匹配串，而不是把 undefined 注入输出。
    return NAMED_ENTITIES[name] ?? m;
  });
}
