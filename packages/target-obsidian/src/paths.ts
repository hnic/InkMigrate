import { existsSync, accessSync, constants } from 'node:fs';
import {
  resolveWithin,
  rejectsTraversal,
  sanitizeFilename,
  type SourceContentKind,
} from '@inkmigrate/core';
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
}

/**
 * §13.3/§13.4 笔记相对路径（相对 Vault 根）：
 * `<importSubdir>/<sourceInstanceId>/<contentKindDir>/<title>-<shortId>.md`
 * 文件名主体过 `sanitizeFilename` 并截断到 `maxFilenameLength`。
 */
export function noteRelativePath(i: NotePathInput): string {
  const dir = CONTENT_KIND_DIR[i.contentKind];
  const body = sanitizeFilename(i.title, {
    maxLength: i.config.maxFilenameLength,
  });
  const filename = `${body}-${i.stableShortId}.md`;
  return [i.config.importSubdir, i.sourceInstanceId, dir, filename]
    .filter(Boolean)
    .join('/');
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

/** §13.7 附件相对路径：`<attachmentsSubdir>/<sourceInstanceId>/<itemKey>/<filename>` */
export function assetRelativePath(i: AssetPathInput): string {
  const safeName = sanitizeFilename(i.filename, { maxLength: 200 });
  return [i.config.attachmentsSubdir, i.sourceInstanceId, i.itemKey, safeName]
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
