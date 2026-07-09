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

const RESIDUAL_HTML = /<\/?[a-z][\s\S]*?>/gi;
const DANGEROUS_SCHEME = /\((javascript|vbscript|file|data):[^)]*\)/gi;
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const MULTI_BLANK = /\n{3,}/g;
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

  s = s.replace(RESIDUAL_HTML, '');
  s = s.replace(DANGEROUS_SCHEME, '()');
  s = s.replace(CONTROL_CHARS, '');
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
  s = s.replace(EMPTY_PARAGRAPH, '\n\n');
  s = s.replace(MULTI_BLANK, '\n\n');

  // 还原代码块和行内代码
  s = s.replace(PH_RE, (_, idx) => placeholders[Number(idx)] ?? '');

  return s.trim();
}
