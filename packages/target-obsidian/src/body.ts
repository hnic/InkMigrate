import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import {
  computeStableKey,
  deriveStableShortId,
  type SourceItem,
} from '@inkmigrate/core';
import { noteFilenameBody } from './paths.js';

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
  /**
   * wikilink 目标的 vault 根前缀（vaultPath 为 vault 子文件夹时非空，见
   * paths.ts detectLinkBase）。链接目标加上前缀后按 Obsidian vault 根严格
   * 解析才能命中；磁盘路径不受影响。
   */
  linkBase?: string;
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
      // 目标必须与磁盘文件名逐字节一致：共用 paths.ts noteRelativePath 的同一
      // 推导（sanitize + maxLength 扣减 + 括号剔除，见 noteFilenameBody 注释），
      // 任一侧独自加工都会让含 `[`/`]` 的标题产生悬空链接。
      // 别名里的 `|` 是 wikilink 分隔符、`[` `]` 会破坏语法，同样剔除
      // （wikilink 内无法转义这些字符）。
      const target = noteFilenameBody(title, {
        suffix,
        maxFilenameLength: ctx.maxFilenameLength,
      });
      const base = ctx.linkBase !== undefined && ctx.linkBase !== '' ? `${ctx.linkBase}/` : '';
      const safeText = text.replace(/[[\]|]/g, '');
      return safeText.length > 0 && text !== title
        ? `[[${base}${target}|${safeText}]]`
        : `[[${base}${target}]]`;
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
  /** wikilink 目标的 vault 根前缀（见 WikilinkResolveContext.linkBase）。 */
  linkBase?: string;
}

/** §13.6 正文模板渲染。 */
export function renderBody(i: RenderBodyInput): string {
  const { item } = i;
  const linkStyle = i.linkStyle ?? 'wikilink';
  // N4（同 来源信息 callout 的 URL 处理）：Markdown 链接目标含空格时必须用
  // <...> 包裹——来源文件名（如 "Screenshot (1).png"、"my file.pdf"）空格合法，
  // 裸拼会把链接截断成坏链。无以上字符时保持裸路径，避免改变既有输出。
  // 除空白外，不成对括号（`shot)2.png` 在 `)` 处截断目标）、`#`（Obsidian 解析为
  // 标题锚点）、`%`（Obsidian 按百分号解码）同样必须包裹——`<`/`>` 已被
  // sanitizeFilename 替换，角括号内的这些字符是安全的。
  const mdDestination = (p: string): string => (/[\s()#%]/.test(p) ? `<${p}>` : p);

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

  const base = i.linkBase !== undefined && i.linkBase !== '' ? `${i.linkBase}/` : '';
  let body = i.markdownBody;
  // 替换附件占位符
  for (const link of i.assetLinks) {
    const embed =
      linkStyle === 'wikilink'
        ? `![[${base}${link.relativePath}]]`
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
          ? `[[${base}${relPath}]]`
          : // 标签转义 `[`/`]`/`\`，目标按 mdDestination 处理空格。
            `[${label.replace(/([\\[\]])/g, '\\$1')}](${mdDestination(relPath)})`;
      lines.push(`- ${link}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 前缀 → 显示标签表：集中维护来源适配器的实例 ID 命名约定（仅显示用，
 * 不参与任何持久化决策）；未命中时显示原始 ID。 */
const SOURCE_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['toutiao', '今日头条'],
  ['evernote', 'Evernote'],
];

/** 从 sourceInstanceId 推导中文来源标签（仅用于显示）。 */
function sourceLabel(item: SourceItem): string {
  const id = item.ref.sourceInstanceId;
  const hit = SOURCE_LABELS.find(([prefix]) => id.startsWith(prefix));
  return hit !== undefined ? hit[1] : id;
}

/** 把 ISO 8601 时间格式化为 "YYYY-MM-DD HH:mm" 显示。 */
function formatDateLine(iso: string): string {
  // 呈现来源时区的墙上时间：直接切片 "2025-12-20T10:35:00+08:00" →
  // "2025-12-20 10:35"（显示 +08:00 时区的时刻，不折算读者本地时区）。
  // 仅 Z 结尾的 UTC 补 " UTC" 标记，避免读者把 UTC 墙上时间误当本地时间
  // （+08:00 用户会差 8 小时）；数字时区不追加偏移量——显示格式已被测试与
  // 既有笔记固化，保持原样。
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(.*)$/.exec(iso);
  if (!m) return iso;
  const zone = m[3] === 'Z' ? ' UTC' : '';
  return `${m[1]} ${m[2]}${zone}`;
}
