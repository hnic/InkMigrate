import { existsSync, accessSync, constants } from 'node:fs';
import {
  resolveWithin,
  rejectsTraversal,
  sanitizeFilename,
  type SourceContentKind,
} from '@inkmigrate/core';
import { basename, dirname, join, resolve } from 'node:path';
import type { ObsidianTargetConfig } from './config.js';

/**
 * §13.2 Vault 初始化与每次写入前的验证：
 * - 路径存在
 * - 可写
 * - 不允许 `../`（rejectsTraversal 兜底）
 *
 * 磁盘空间与符号链接逃逸由调用方在写入具体文件时通过 core 的
 * `assertSymlinkSafe` 复核（target-obsidian 在阶段 2 不深度使用，因为
 * 原子写入已经在受控目录内完成；阶段 3 来源适配器接入真实附件下载后
 * 会用到符号链接防护）。
 */
export function validateVault(vaultPath: string): void {
  if (rejectsTraversal(vaultPath)) {
    throw new Error(`vaultPath contains traversal segments: "${vaultPath}"`);
  }
  if (!existsSync(vaultPath)) {
    throw new Error(`vault does not exist: "${vaultPath}"`);
  }
  try {
    accessSync(vaultPath, constants.W_OK);
  } catch {
    throw new Error(`vault is not writable: "${vaultPath}"`);
  }
}

/** §13.3 不同 contentKind 对应的中文子目录。 */
const CONTENT_KIND_DIR: Readonly<Record<SourceContentKind, string>> = {
  article: '文章',
  'short-post': '微头条',
  gallery: '图集',
  'question-answer': '问答',
  video: '视频',
  note: '笔记',
  'external-link': '外部链接',
  unknown: '未知类型',
};

export interface NotePathInput {
  config: ObsidianTargetConfig;
  sourceInstanceId: string;
  contentKind: SourceContentKind;
  title: string;
  stableShortId: string;
  /**
   * §13.3 来源提供的笔记目录段（如 Evernote 的 `[Stack, "笔记本-<shortId>"]`）。
   * 存在且非空时替代 contentKind 目录；每段独立清洗，防注入路径分隔符。
   */
  notePathSegments?: readonly string[];
}

/**
 * §13.4 笔记文件名主体（标题清洗 + 截断 + shortId 后缀拼接）。
 *
 * #623：noteRelativePath（磁盘文件名）与 body.ts convertEvernoteWikilinks
 * （wikilink 目标）【必须】共用此推导——链接目标与文件名逐字节一致是链接可
 * 解析的前提，任一侧独自加工（历史上 wikilink 侧单独剔括号）都会让含 `[`/`]`
 * 的标题产生悬空链接（Obsidian 点击即新建空笔记）。sanitizeFilename 不替换
 * `[` `]`，而 `]]` 会提前终止 wikilink，故拼接后统一剔除；剔空（标题仅剩
 * 括号的病态情况）回退 '_'，保证文件名与链接目标都非空且一致。
 */
export function noteFilenameBody(
  title: string,
  opts: { suffix: string; maxFilenameLength: number },
): string {
  const combined = `${sanitizeFilename(title, {
    maxLength: Math.max(1, opts.maxFilenameLength - opts.suffix.length),
  })}${opts.suffix}`.replace(/[[\]]/g, '');
  return combined || '_';
}

/**
 * §13.3/§13.4 笔记相对路径（相对 Vault 根）：
 * `<importSubdir>/<sourceInstanceId>/<contentKindDir>/<title>-<shortId>.md`
 *
 * 文件名由 noteFilenameBody(title)（sanitize + 截断 + 括号剔除）+ `-` +
 * stableShortId 组成（见该函数注释的链接一致性要求）。stableShortId
 * 后缀是断点续跑/重跑幂等的关键：同一指纹始终落到同一稳定路径，不依赖 planNote
 * 的 `pathInUse` stat 兜底（后者会在重跑时把已存在文件误判为冲突，生成 -2/-3 冗余副本）。
 *
 * body 过 `sanitizeFilename` 并截断，截断上限预先扣除 `-shortId` 的长度，
 * 使最终文件名总长 ≤ `maxFilenameLength`。shortId 同样 sanitize 以保证一致性与字符安全。
 *
 * I15: sourceInstanceId 来自来源适配器配置（半可信），原样拼入路径会创建意外子目录
 * （含 `/`）或注入控制字符到文件名。统一 sanitize 为单段路径（替换路径分隔符）。
 */
export function noteRelativePath(i: NotePathInput): string {
  // §13.4 filenameShortId=false 时纯标题名（一次性迁移的干净命名；重跑幂等
  // 依赖 -2/-3 序号兜底，可能产生副本——用户显式选择）
  const suffix = i.config.filenameShortId
    ? `-${sanitizeFilename(i.stableShortId, { maxLength: 32 })}`
    : '';
  const body = noteFilenameBody(i.title, {
    suffix,
    maxFilenameLength: i.config.maxFilenameLength,
  });
  const filename = `${body}.md`;
  const safeSourceId = sanitizePathSegment(i.sourceInstanceId);
  // importSubdir 为空 = 省略该段（笔记位于 <sourceInstanceId>/... 下），
  // 不再回退为 Vault 根平铺（索引生成器同语义）
  // §13.3 来源目录段优先（Evernote Stack/笔记本层级）；缺失时按 contentKind 目录
  if (i.notePathSegments !== undefined && i.notePathSegments.length > 0) {
    const segments = i.notePathSegments.map((s) =>
      sanitizePathSegment(sanitizeFilename(s, { maxLength: 80 })),
    );
    return [i.config.importSubdir, safeSourceId, ...segments, filename]
      .filter(Boolean)
      .join('/');
  }
  const dir = CONTENT_KIND_DIR[i.contentKind];
  return [i.config.importSubdir, safeSourceId, dir, filename]
    .filter(Boolean)
    .join('/');
}

/**
 * I15: 把来源实例 ID 规范化为单一安全路径段——替换正反斜杠为 `-`（防止创建意外
 * 子目录层级或 `..` 逃逸），其余字符安全性由下游 resolveWithin 在写入时兜底。
 *
 * L10: 导出供 index-generator 复用（原仅 paths.ts 内部使用，index-generator
 * 原始拼接 sourceInstanceId，未走此清洗，不一致）。
 */
export function sanitizePathSegment(seg: string): string {
  return seg.replace(/[\\/]/g, '-');
}

/** §13.2 把 Vault 内相对路径解析为绝对路径，并在解析时拒绝逃逸。 */
export function noteAbsolutePath(
  vaultPath: string,
  relativePath: string,
): string {
  return resolveWithin(vaultPath, relativePath);
}

export interface AssetPathInput {
  config: ObsidianTargetConfig;
  sourceInstanceId: string;
  itemKey: string;
  filename: string;
}

/** §13.7 附件相对路径。
 * by-note（默认）：`<attachmentsSubdir>/<sourceInstanceId>/<itemKey>/<filename>`。
 * flat：`<attachmentsSubdir>/<filename>` 平铺（同名异内容冲突由 plan 阶段消解）。 */
export function assetRelativePath(i: AssetPathInput): string {
  // wikilink 嵌入安全（与 body.ts 的 ![[...]]/[[...]] 渲染同源）：sanitizeFilename
  // 不替换 `[` `]` `#` `^`——`]]` 会提前终止嵌入，`#`/`^` 被 Obsidian 解析为
  // 标题/块引用（链接指向不存在的锚点）。在路径分配的单一出口处统一剔除，
  // 保证链接目标与磁盘文件名逐字节一致；剔空回退 'asset'。同名剔除后碰撞由
  // planNote 的 allocAssetPath -2/-3 消歧兜底。
  const safeName =
    sanitizeFilename(i.filename, { maxLength: 200 }).replace(/[[\]#^]/g, '') ||
    'asset';
  if (i.config.attachmentPathLayout === 'flat') {
    return [i.config.attachmentsSubdir, safeName].filter(Boolean).join('/');
  }
  const safeSourceId = sanitizePathSegment(i.sourceInstanceId);
  return [i.config.attachmentsSubdir, safeSourceId, i.itemKey, safeName]
    .filter(Boolean)
    .join('/');
}

/** §13.2 解析附件相对路径为绝对路径（同 noteAbsolutePath 语义）。 */
export function assetAbsolutePath(
  vaultPath: string,
  relativePath: string,
): string {
  return resolveWithin(vaultPath, relativePath);
}

/**
 * 探测 vaultPath 相对 Obsidian vault 根的路径前缀（wikilink 语义对齐）。
 *
 * Obsidian 的 wikilink 按 vault 根解析，而本适配器的全部相对路径（笔记/附件/
 * 索引）以 vaultPath 为基准。当用户把 vault 的子文件夹当迁移目标（如
 * `<vault>/toutiao`）时，两个基准不一致：链接文本按 vaultPath 相对生成，
 * Obsidian 却到 vault 根下找，产生断链/错配（2026-09-11 实测）。
 *
 * 判据：vaultPath 的祖先目录里最近的含 `.obsidian` 者（多层 .obsidian 时取最近
 * ——与 Obsidian 打开内层为独立 vault 的语义一致）即 vault 根，返回它到
 * vaultPath 的相对路径（posix 斜杠）。vaultPath 自身含 `.obsidian` 不算——
 * 那说明 vaultPath 就是 vault 根；祖先均无 `.obsidian`（目录还没在 Obsidian
 * 打开过等）返回空串，维持现行为（链接 = vaultPath 相对路径）。
 */
export function detectLinkBase(vaultPath: string): string {
  const segments: string[] = [];
  let dir = resolve(vaultPath);
  for (;;) {
    // 当前层先进 segments 再查父亲——命中时当前层（vaultPath 侧）必须计入前缀
    segments.push(basename(dir));
    const parent = dirname(dir);
    if (parent === dir) return '';
    if (existsSync(join(parent, '.obsidian'))) {
      return segments.reverse().join('/');
    }
    dir = parent;
  }
}
