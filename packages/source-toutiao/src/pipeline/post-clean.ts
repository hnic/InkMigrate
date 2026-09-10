import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { decodeHtmlEntities } from '@inkmigrate/core';

/**
 * §12.9 stage 8：Markdown 后清洗。
 *
 * - 移除残留原始 HTML（任何 `<tag>`）。
 * - 移除危险 URL scheme（javascript:/vbscript:/file:/data: 在链接里）。
 * - 移除不可见控制字符（除 \t \n \r）。
 * - 连续空行最多两个。
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(gfm);

/** §12.9 stage 7：把已清洗 HTML 转 Markdown。 */
export function htmlToMarkdownSafe(html: string): string {
  return turndown.turndown(html).trim();
}

// 残留 HTML 只按单行标签形态移除（标签内不含 < > \n）：
// [\s\S]*? 可跨行匹配，普通散文里 "a<b and c>d" / "x<y\nthen y>z" 会被整段吞掉
const RESIDUAL_HTML = /<\/?[a-z][^<>\n]*>/gi;
// 仅锚定 Markdown 链接语法 ]( ——裸 \((file|data):…\) 会误伤正文括号散文
//（如 "(file: 见附件)"），替换保留 ]() 与链接文字而非整段删除
const DANGEROUS_SCHEME = /\]\(\s*(?:javascript|vbscript|file|data):[^)]*\)/gi;
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const NESTED_LINK = /\[((?:\[[^\]]*\]|[^\]])*)\]\(([^)]*)\)/g;
const EMPTY_PARAGRAPH = /\n\s*\n\s*\n/g;

// 代码块/行内代码匹配
const CODE_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`]+`/g;

/** §12.9 stage 8：Markdown 后清洗。 */
export function postCleanMarkdown(md: string): string {
  // 先隔离代码块和行内代码，避免正则误杀代码中的尖括号（如 List<String>）。
  // 占位边界用 Unicode 私有区码点（U+E000/U+E001），绝不能用 C0 控制字符（\x00 等）——
  // 下面的 CONTROL_CHARS 正则会删除所有 C0 字符，会吞掉占位符两端导致还原失配、代码块丢失。
  const PH_OPEN = '\uE000CODE';
  const PH_CLOSE = '\uE001';
  const PH_RE = /\uE000CODE(\d+)\uE001/g;
  const placeholders: string[] = [];
  let s = md
    // 源文档若本就含 U+E000/U+E001（或字面 "\uE000CODE0\uEE001" 串），还原阶段
    // 会被当成我们的占位符替换进错误内容——先剔除再抽取，杜绝碰撞
    .replace(/[\uE000\uE001]/g, '')
    .replace(CODE_BLOCK, (m) => {
      const idx = placeholders.length;
      placeholders.push(m);
      return `${PH_OPEN}${idx}${PH_CLOSE}`;
    })
    .replace(INLINE_CODE, (m) => {
      const idx = placeholders.length;
      placeholders.push(m);
      return `${PH_OPEN}${idx}${PH_CLOSE}`;
    });

  // 先移除控制字符、再查危险 scheme：顺序反了的话，"java\x0Bscript:" 这类
  // 混淆值会先通过 scheme 检查、控制字符剔除后又拼回合法 javascript: 链接
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(RESIDUAL_HTML, '');
  s = s.replace(DANGEROUS_SCHEME, ']()');
  // §13.6 解码泄漏的 HTML 实体：HTML 经多次 innerHTML 序列化后，属性值里的
  // `"` 被重编码为 `&quot;`，会漏进 Markdown。在代码块已占位后解码，避免误伤
  // 代码内容；不解码 &lt;/&gt; 以免绕过 stage 5 的 HTML Sanitization。
  s = decodeHtmlEntities(s);
  // 折叠异常嵌套链接（多次扫描，处理三层以上嵌套）
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NESTED_LINK, (match, text: string, _url: string) => {
      // §I-A：图片链接 [![alt](img)](link) 不能折叠成 [alt](img)，否则外层链接 URL 丢失。
      // 含图片语法（![）时原样返回，不折叠。
      if (text.includes('![')) return match;
      if (/\]\([^)]*\)/.test(text)) {
        const inner = /\[([^\]]*)\]\(([^)]*)\)/.exec(text);
        if (inner) {
          return `[${inner[1]}](${inner[2]})`;
        }
      }
      return match;
    });
    if (before === s) break;
  }
  // 连续空行折叠到最多两行：EMPTY_PARAGRAPH 的 \s* 可吞并任意 3+ 换行/空白行
  // 序列，单独的 MULTI_BLANK/\n{3,}/ 在其后不可能再命中（已删除，避免误导）
  s = s.replace(EMPTY_PARAGRAPH, '\n\n');

  // 还原代码块和行内代码；索引失配时回退保留原文而非静默删除代码
  s = s.replace(PH_RE, (m, idx) => placeholders[Number(idx)] ?? m);

  return s.trim();
}
