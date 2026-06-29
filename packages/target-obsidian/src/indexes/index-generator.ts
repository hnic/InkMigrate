import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { assertSymlinkSafe, writtenFileHash, resolveWithin, sanitizeFilename } from '@inkmigrate/core';
import type { ObsidianTargetConfig } from '../config.js';

export interface IndexEntry {
  title: string;
  relativePath: string;
  contentKind: string;
  publishedAt?: string;
  favoritedAt?: string;
  collections: string[];
}

export interface KnownIndexArtifact {
  /** 上次生成时记录的索引文件 relativePath（相对 Vault 根）。 */
  relativePath: string;
  /** 上次生成时落库的 writtenFileHash，用于检测用户是否手改。 */
  writtenFileHash: string;
}

export interface ShardResult {
  relativePath: string;
  shardKey: string;
  entries: IndexEntry[];
  /** 本次写入后的 writtenFileHash（冲突跳过时为磁盘原内容哈希）。供 artifact 追踪。 */
  writtenFileHash?: string;
  /** §13.8 用户手改过该分片 → 本次跳过覆写、保留用户文件。 */
  skippedDueToConflict?: boolean;
}

export interface GenerateIndexResult {
  shards: ShardResult[];
  entryIndex: { relativePath: string; writtenFileHash?: string; skippedDueToConflict?: boolean };
}

export interface GenerateIndexInput {
  config: ObsidianTargetConfig;
  vaultPath: string;
  sourceInstanceId: string;
  entries: readonly IndexEntry[];
  groupBy: readonly ('month' | 'content-type' | 'collection' | 'notebook')[];
  /**
   * §13.8 重跑保护：传入上一轮已落库的索引 artifact（relativePath + writtenFileHash）。
   * 若磁盘文件已被用户修改（on-disk 哈希 ≠ recorded），本次跳过覆写该分片，
   * 保留用户内容。留空 = 全量生成（首次运行）。
   */
  knownArtifacts?: readonly KnownIndexArtifact[];
}

/**
 * §13.8 生成分片索引。
 *
 * 按 `groupBy` 有序数组分组，每组生成一个 Markdown 分片索引。
 * 总入口只链接分片，不直接列出条目。
 */
export function generateShardIndexes(i: GenerateIndexInput): GenerateIndexResult {
  const indexDir = `${i.config.importSubdir}/${i.sourceInstanceId}/_索引`;
  const knownByPath = new Map((i.knownArtifacts ?? []).map((a) => [a.relativePath, a.writtenFileHash]));

  const groups = new Map<string, IndexEntry[]>();
  for (const entry of i.entries) {
    const key = buildShardKey(entry, i.groupBy);
    const arr = groups.get(key) ?? [];
    arr.push(entry);
    groups.set(key, arr);
  }

  const shards: ShardResult[] = [];
  for (const [shardKey, shardEntries] of [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const safeName = sanitizeFilename(shardKey, { maxLength: 80 });
    const relativePath = `${indexDir}/${safeName}.md`;
    // §缺陷4：markdown 链接需相对分片文件本身（位于 _索引/ 下）解析，否则
    // 渲染器会按当前目录拼接出 _索引/Imports/... 的 404 路径。用 path.relative
    // 计算分片目录到目标文章的真正相对路径。wikilink [[...]] 按 Vault 根解析，无需调整。
    const content = renderShardMarkdown(
      shardKey,
      shardEntries,
      i.config.linkStyle,
      dirname(relativePath),
    );
    const written = writeShard(i.vaultPath, relativePath, content, knownByPath.get(relativePath));
    shards.push({
      relativePath,
      shardKey,
      entries: shardEntries,
      writtenFileHash: written.hash,
      skippedDueToConflict: written.skipped,
    });
  }

  const entryIndexRel = `${i.config.importSubdir}/${i.sourceInstanceId}/${i.sourceInstanceId}收藏索引.md`;
  const entryContent = renderEntryIndex(shards, i.sourceInstanceId);
  const entryWritten = writeShard(i.vaultPath, entryIndexRel, entryContent, knownByPath.get(entryIndexRel));

  return {
    shards,
    entryIndex: {
      relativePath: entryIndexRel,
      writtenFileHash: entryWritten.hash,
      skippedDueToConflict: entryWritten.skipped,
    },
  };
}

function buildShardKey(
  entry: IndexEntry,
  groupBy: readonly string[],
): string {
  const parts: string[] = [];
  for (const dim of groupBy) {
    if (dim === 'month') {
      const date = entry.favoritedAt ?? entry.publishedAt ?? '';
      const m = /^(\d{4}-\d{2})/.exec(date);
      parts.push(m?.[1] ?? '未知日期');
    } else if (dim === 'content-type') {
      parts.push(entry.contentKind);
    } else if (dim === 'collection') {
      parts.push(entry.collections[0] ?? '未分组');
    }
  }
  return parts.join('-') || '全部';
}

function renderShardMarkdown(
  shardKey: string,
  entries: readonly IndexEntry[],
  linkStyle: 'wikilink' | 'markdown',
  /** 分片文件所在目录（相对 Vault 根），用于计算 markdown 链接的相对路径。§缺陷4 */
  shardDir: string,
): string {
  const lines: string[] = [`# ${shardKey}`, ''];
  for (const e of entries) {
    if (linkStyle === 'wikilink') {
      lines.push(`- [[${e.relativePath.replace(/\.md$/, '')}|${e.title}]]`);
    } else {
      // markdown 链接按当前分片文件所在目录解析；用相对路径避免 404
      const rel = relative(shardDir, e.relativePath);
      lines.push(`- [${e.title}](${rel})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderEntryIndex(
  shards: readonly ShardResult[],
  sourceInstanceId: string,
): string {
  const lines: string[] = [
    `# ${sourceInstanceId} 收藏索引`,
    '',
    '> 本文件由 InkMigrate 自动生成，请勿手动编辑。',
    '',
  ];
  for (const shard of shards) {
    const link = shard.relativePath.replace(/\.md$/, '');
    lines.push(`- [[${link}|${shard.shardKey}]]`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * §13.8/§13.10 安全写入分片索引：
 *
 * 1. **符号链接防逃逸**：用 resolveWithin 锁定 Vault 内 + 解引用后 assertSymlinkSafe
 *    再写（§13.2）。不能用 atomicWrite（其要求 `---` frontmatter，分片以 `#` 开头），
 *    故在此内联等价的安全检查。
 * 2. **重跑保护**（§13.8 "可重复生成且不覆盖用户笔记"）：若调用方传入上一轮的
 *    recordedHash，且磁盘文件已被用户修改（on-disk 哈希 ≠ recordedHash），则**跳过
 *    覆写**，保留用户文件并返回磁盘原哈希 + skipped=true。
 *
 * 返回 { hash, skipped } 供 artifact 追踪。
 */
function writeShard(
  vaultPath: string,
  relativePath: string,
  content: string,
  recordedHash?: string,
): { hash: string; skipped: boolean } {
  const abs = resolveWithin(vaultPath, relativePath);

  // §13.8 重跑保护：已有文件 + 用户改过 → 保留用户内容，不覆写
  if (recordedHash !== undefined && existsSync(abs)) {
    const onDisk = writtenFileHash(Buffer.from(readFileSync(abs, 'utf8'), 'utf8'));
    if (onDisk !== recordedHash) {
      // 用户修改过：跳过覆写，返回磁盘原哈希
      return { hash: onDisk, skipped: true };
    }
  }

  // §13.2 符号链接逃逸防护：先建目录链，再对【父目录】解引用确认位于 Vault 内。
  // 目标文件可能尚不存在（realpathSync 会 ENOENT），符号链接攻击面在父目录链，
  // 故校验父目录即可；与 atomicWrite 对 tmpPath 父目录的校验等价。
  mkdirSync(join(abs, '..'), { recursive: true });
  assertSymlinkSafe(vaultPath, join(abs, '..'));
  writeFileSync(abs, content, 'utf8');
  return { hash: writtenFileHash(Buffer.from(content, 'utf8')), skipped: false };
}
