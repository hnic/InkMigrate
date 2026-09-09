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
// §12.9 stage 1：不设置 runScripts（jsdom 默认）即完全禁用脚本执行。
// 注意 'outside-only' 并不等于禁用——它仍会在 window 上安装 eval 等执行器，
// 而本模块的单例 window 流过全部不可信文章 HTML，必须彻底关闭该入口。
const dom = new JSDOM('');
// 窄化 cast：dompurify 自带类型（WindowLike）与 jsdom DOMWindow 结构不一致，
// 经 unknown 中转仅屏蔽这一处差异，两侧其余类型检查仍然生效（拒绝 as never
// 这类全面静默的写法）。
const DOMPurify = createDompurify(
  dom.window as unknown as Parameters<typeof createDompurify>[0],
);
if (!DOMPurify.isSupported) {
  // isSupported=false 时 sanitize 等于原样放行脏输入，是本阶段最危险的失败
  // 模式，必须启动即失败而非静默继续。
  throw new Error('DOMPurify 不支持当前 jsdom window，拒绝执行 sanitize（§12.9 stage 5）');
}

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

/** §12.9 stage 6 在 stage 5 之后解析的懒加载属性。 */
const LAZY_LOAD_ATTRS = ['data-src', 'data-original', 'data-lazy-src'] as const;

const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'lang',
  'dir',
  ...LAZY_LOAD_ATTRS,
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

// dompurify 的 ALLOWED_URI_REGEXP 按属性【整值】匹配，对两类属性会漏：
// 1. srcset 是逗号分隔的候选列表——首候选满足白名单时，后续候选（如
//    `javascript:alert(1) 2x`）可原样存活到 stage 6 输出（stage 6 只提升首候选、
//    从不移除该属性）。这里逐候选校验，任一不合法即整个移除。
// 2. data-* 懒加载属性"必须存活到 stage 6"的契约此前隐式依赖 dompurify 内部
//    对 ALLOWED_ATTR 中 data-* 值的 URI 校验顺序，升级可能悄悄改变行为；此处
//    显式执行同一白名单，契约由本模块自己保证。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof dom.window.Element)) return;
  const srcset = node.getAttribute('srcset');
  if (
    srcset !== null &&
    !srcset.split(',').every((candidate) =>
      SAFE_URI.test(candidate.trim().split(/\s+/)[0] ?? ''),
    )
  ) {
    node.removeAttribute('srcset');
  }
  for (const attr of LAZY_LOAD_ATTRS) {
    const v = node.getAttribute(attr);
    if (v !== null && !SAFE_URI.test(v)) {
      node.removeAttribute(attr);
    }
  }
});

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
