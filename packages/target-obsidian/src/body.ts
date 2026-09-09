import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  computeStableKey,
  deriveStableShortId,
  sanitizeFilename,
  type SourceItem,
} from '@inkmigrate/core';

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

export interface WikilinkResolveContext {
  /** 链接所属来源实例（推导目标笔记的 stableShortId）。 */
  sourceInstanceId: string;
  /** §13.4 是否在目标文件名携带 shortId 后缀（与当前迁移的目标配置一致）。 */
  filenameShortId: boolean;
  /** §13.4 标题主体长度上限（与目标配置一致，保证 wikilink 指向真实文件名）。 */
  maxFilenameLength: number;
}

/**
 * §15.10 内部链接后处理：来源侧（Evernote 适配器）把可解析的 evernote:// 链接
 * 输出为 evernote-wikilink://<指纹>/<encodeURIComponent(标题)> 伪链接
 * （turndown 转为 markdown 链接、不转义方括号）。此处按目标端自身的命名布局
 * （filenameShortId 开关）还原为指向真实文件名的 Obsidian wikilink；
 * 链接文字与目标标题同名时省略别名。
 */
export function convertEvernoteWikilinks(markdown: string, ctx: WikilinkResolveContext): string {
  return markdown.replace(
    /\[([^\]]*)\]\(evernote-wikilink:\/\/([0-9a-f]{64})\/([^)\s]+)\)/g,
    (_m, text: string, fingerprint: string, encTitle: string) => {
      let title: string;
      try {
        title = decodeURIComponent(encTitle);
      } catch {
        // 非法百分号编码（用户手写的坏链接）：退回原始串，
        // 避免单个坏链接抛 URIError 中断整篇转换。
        title = encTitle;
      }
      const suffix = ctx.filenameShortId
        ? `-${deriveStableShortId(computeStableKey(ctx.sourceInstanceId, `sha256:${fingerprint}`))}`
        : '';
      // 目标与别名都要剔除会破坏 wikilink 语法的字符：sanitizeFilename 只替换
      // `\ / : * ? " < > |`，`[` `]` 会残留（目标含 `]]` 会提前终止链接）；
      // 别名里的 `|` 是分隔符，同样剔除（wikilink 内无法转义这些字符）。
      const target = `${sanitizeFilename(title, {
        maxLength: Math.max(1, ctx.maxFilenameLength - suffix.length),
      })}${suffix}`.replace(/[[\]]/g, '');
      const safeText = text.replace(/[[\]|]/g, '');
      return safeText.length > 0 && text !== title
        ? `[[${target}|${safeText}]]`
        : `[[${target}]]`;
    },
  );
}

export interface AssetLink {
  /**
   * 在 markdownBody 中占位的字符串，渲染后会被替换为实际嵌入语法。
   *
   * 契约：全部占位符必须互不为子串/前缀（按任意顺序替换都唯一确定），
   * 且不会自然出现在正文中——adapter 当前的 `\x00IMG<n>\x00` 方案满足
   * （结尾 `\x00` 保证 IMG1 不是 IMG10 的子串）；更换方案时需保持该性质。
   */
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
  // N4（同 来源信息 callout 的 URL 处理）：Markdown 链接目标含空格时必须用
  // <...> 包裹——来源文件名（如 "Screenshot (1).png"、"my file.pdf"）空格合法，
  // 裸拼会把链接截断成坏链。无空格时保持裸路径，避免改变既有输出。
  const mdDestination = (p: string): string => (/\s/.test(p) ? `<${p}>` : p);

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
        : `![](${mdDestination(link.relativePath)})`;
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
      const link =
        linkStyle === 'wikilink'
          ? `[[${relPath}]]`
          : // 标签转义 `[`/`]`/`\`，目标按 mdDestination 处理空格。
            `[${label.replace(/([\\[\]])/g, '\\$1')}](${mdDestination(relPath)})`;
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
  // 保持时区信息：直接切片 "2025-12-20T10:35:00+08:00" → "2025-12-20 10:35"。
  // Z 结尾的 UTC 时间补 " UTC" 标记，避免读者把 UTC 墙上时间误当本地时间
  // （+08:00 用户会差 8 小时）。
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(.*)$/.exec(iso);
  if (!m) return iso;
  const zone = m[3] === 'Z' ? ' UTC' : '';
  return `${m[1]} ${m[2]}${zone}`;
}
