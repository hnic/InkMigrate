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
 * §12.9 允许的 URI 规则：正向白名单（而非黑名单）。
 *
 * C13: 原实现用负向先行断言（黑名单 `^(?!javascript:|...)`）只拒绝已知危险 scheme，
 * 与 stage 5"允许列表 HTML Sanitization"的设计意图矛盾——黑名单一旦遗漏新 scheme
 * （mhtml:/x-schema: 等）即漏。改为正向白名单：
 * - 显式安全 scheme：http/https/ftp/mailto/tel
 * - 相对路径/锚点/query：以 `#`、`/`、`./`、`../`、`?` 开头
 * - 无 scheme 的纯相对路径（如 `img/x.webp`、`foo`）：首段（到第一个 / ? # 之前）不含 `:`
 *   ——含 `:` 的首段必是 scheme（如 `javascript:`、`data:`），拒绝。
 * 白名单比 DOMPurify 默认更严，杜绝 scheme 注入面。
 */
const SAFE_URI =
  /^(?:(?:https?|ftp|mailto|tel):|[/?#]|[^/?#:]+(?:[/?#]|$))/i;

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    // I7: DOMPurify 中 ALLOWED_TAGS 优先级高于 FORBID_TAGS，同时设置时 FORBID 被忽略。
    // form/input/button/style 本就不在 ALLOWED_TAGS 里，删除冗余 FORBID 配置以免误导。
    ALLOWED_URI_REGEXP: SAFE_URI,
  }) as string;
}
