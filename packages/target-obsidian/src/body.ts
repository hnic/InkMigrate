import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { SourceItem } from '@inkmigrate/core';

/** §13.6 共享的 turndown 实例（启用 GFM 表格/任务列表）。 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(gfm);

// 显式移除 script/style，避免任何残留（turndown 默认会忽略未知标签，
// 但脚本内容可能漏出）。
turndown.remove('script');
turndown.remove('style');

/** §13.6 把来源 HTML 转为 Markdown。 */
export function htmlToMarkdown(html: string): string {
  if (html.trim().length === 0) return '';
  return turndown.turndown(html).trim();
}

/**
 * §15.10 内部链接后处理：来源侧（Evernote 适配器）把可解析的 evernote:// 链接
 * 输出为 evernote-wikilink:// 伪链接（turndown 转为 markdown 链接、不转义方括号），
 * 此处还原为 Obsidian wikilink；链接文字与目标同名时省略别名。
 */
export function convertEvernoteWikilinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]]*)\]\(evernote-wikilink:\/\/([^)\s]+)\)/g,
    (_m, text: string, encoded: string) => {
      const target = decodeURIComponent(encoded);
      return text.length > 0 && text !== target
        ? `[[${target}|${text.replace(/[[\]|]/g, '')}]]`
        : `[[${target}]]`;
    },
  );
}

export interface AssetLink {
  /** 在 markdownBody 中占位的字符串，渲染后会被替换为实际嵌入语法。 */
  markdownPlaceholder: string;
  /** 附件在 Vault 内的相对路径。 */
  relativePath: string;
}

export interface RenderBodyInput {
  item: SourceItem;
  /** 已经 HTML→Markdown 转换好的正文。 */
  markdownBody: string;
  /** 正文中的附件引用。 */
  assetLinks: AssetLink[];
  /** §15.7.5 文末附件区的附件相对路径（未内联进正文的资源）。 */
  attachmentLinks?: readonly string[];
  /** §13.7 链接风格，默认 wikilink。 */
  linkStyle?: 'wikilink' | 'markdown';
}

/** §13.6 正文模板渲染。 */
export function renderBody(i: RenderBodyInput): string {
  const { item } = i;
  const linkStyle = i.linkStyle ?? 'wikilink';

  const lines: string[] = [];

  // 来源信息 callout
  const infoLines: string[] = [];
  infoLines.push(`- 来源：${sourceLabel(item)}`);
  if (item.author !== undefined) infoLines.push(`- 作者：${item.author}`);
  if (item.publishedAt !== undefined) {
    infoLines.push(`- 发布时间：${formatDateLine(item.publishedAt)}`);
  }
  if (item.favoritedAt !== undefined) {
    infoLines.push(`- 收藏时间：${formatDateLine(item.favoritedAt)}`);
  }
  if (item.ref.canonicalUrl !== undefined) {
    // N4: URL 用 <...> 包裹，避免含 ) 的 URL 截断 Markdown 链接。
    infoLines.push(`- [打开原文](<${item.ref.canonicalUrl}>)`);
  }
  lines.push('> [!info] 来源信息');
  for (const l of infoLines) lines.push(`> ${l}`);
  lines.push('');

  let body = i.markdownBody;
  // 替换附件占位符
  for (const link of i.assetLinks) {
    const embed =
      linkStyle === 'wikilink'
        ? `![[${link.relativePath}]]`
        : `![](${link.relativePath})`;
    body = body.split(link.markdownPlaceholder).join(embed);
  }
  lines.push(body);
  lines.push('');

  // §15.7.5 附件区：未内联进正文的资源（PDF/Office/音视频、未引用图片）统一列出
  if (i.attachmentLinks !== undefined && i.attachmentLinks.length > 0) {
    lines.push('## 附件');
    lines.push('');
    for (const relPath of i.attachmentLinks) {
      const label = relPath.split('/').pop() ?? relPath;
      const link = linkStyle === 'wikilink' ? `[[${relPath}]]` : `[${label}](${relPath})`;
      lines.push(`- ${link}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 从 sourceInstanceId 推导中文来源标签（仅用于显示）。 */
function sourceLabel(item: SourceItem): string {
  const id = item.ref.sourceInstanceId;
  if (id.startsWith('toutiao')) return '今日头条';
  if (id.startsWith('evernote')) return 'Evernote';
  return id;
}

/** 把 ISO 8601 时间格式化为 "YYYY-MM-DD HH:mm" 显示。 */
function formatDateLine(iso: string): string {
  // 保持时区信息：直接切片 "2025-12-20T10:35:00+08:00" → "2025-12-20 10:35"
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}
