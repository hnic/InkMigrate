import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

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
// §12.9 stage 8 异常嵌套链接：把 `[text [inner](url1)](url2)` 形式的畸形链接
// 折叠为内层链接（保留最内层的 URL）。非贪婪匹配两层方括号。
const NESTED_LINK = /\[((?:\[[^\]]*\]|[^\]])*)\]\(([^)]*)\)/g;
// 空段落：连续的空强调/弱化标记，或仅含空白
const EMPTY_PARAGRAPH = /\n\s*\n\s*\n/g;

/** §12.9 stage 8：Markdown 后清洗。 */
export function postCleanMarkdown(md: string): string {
  let s = md;
  s = s.replace(RESIDUAL_HTML, '');
  s = s.replace(DANGEROUS_SCHEME, '()');
  s = s.replace(CONTROL_CHARS, '');
  // 折叠异常嵌套链接（多次扫描，处理三层以上嵌套）
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(NESTED_LINK, (match, text: string, url: string) => {
      // 如果 text 内部还含 `](...)`，说明是嵌套链接，折叠为内层
      if (/\]\([^)]*\)/.test(text)) {
        // 提取最内层 `[inner](innerUrl)`
        const inner = /\[([^\]]*)\]\(([^)]*)\)/.exec(text);
        if (inner) {
          return `[${inner[1]}](${inner[2]})`;
        }
      }
      return match;
    });
    if (before === s) break;
  }
  // 删除空段落（连续 3+ 换行折叠为 2，再处理残留）
  s = s.replace(EMPTY_PARAGRAPH, '\n\n');
  s = s.replace(MULTI_BLANK, '\n\n');
  return s.trim();
}
