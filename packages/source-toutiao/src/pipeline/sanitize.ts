import { JSDOM } from 'jsdom';
import createDompurify from 'dompurify';

/**
 * §12.9 stage 5：允许列表 HTML Sanitization。
 *
 * 用 dompurify 在 jsdom window 上构造一个 Sanitizer，配置明确允许列表：
 * - 允许常见正文标签（p/h1-h6/ul/ol/li/a/strong/em/blockquote/code/pre/img/table 等）
 * - 删除 `on*` 属性、`javascript:`、不受控 `data:`、表单、可执行嵌入
 *
 * 输入必须是已经过 pre-clean 的 HTML；不允许跳过本步骤（§12.9）。
 */

// jsdom window 用于初始化 dompurify（隔离于 Playwright 的页面 window）。
// §12.9 stage 1：所有 jsdom 实例必须显式禁用脚本执行。
// `as never` 绕过 @types/dompurify 与 jsdom Window 之间的结构差异（运行时兼容）。
const dom = new JSDOM('', { runScripts: 'outside-only', resources: undefined });
const DOMPurify = createDompurify(dom.window as never);

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark',
  'blockquote', 'q', 'cite',
  'code', 'pre', 'kbd', 'samp',
  'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'dl', 'dt', 'dd',
];

const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'lang',
  'dir',
  // §12.9 stage 6 在 stage 5 之后；懒加载属性必须存活到 stage 6 解析。
  // 这些是内容属性，非危险属性，允许通过 stage 5。
  'data-src',
  'data-original',
  'data-lazy-src',
  'srcset',
];

/**
 * §12.9 允许的 URI 规则：默认放行，仅拒绝已知危险 scheme。
 *
 * 危险 scheme：javascript:、vbscript:、data:（不受控）、file:。
 * 其余（http/https/mailto/ftp/tel + 相对 URL + 锚点）都允许通过；
 * 相对 URL 在 stage 6 解析为绝对。
 */
const SAFE_URI = /^(?!javascript:|vbscript:|data:|file:)/i;

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'option', 'textarea', 'style'],
    FORBID_ATTR: ['style', 'class'],
    ALLOWED_URI_REGEXP: SAFE_URI,
  }) as string;
}
