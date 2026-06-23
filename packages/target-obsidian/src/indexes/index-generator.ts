import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWithin, sanitizeFilename } from '@inkmigrate/core';
import type { ObsidianTargetConfig } from '../config.js';

export interface IndexEntry {
  title: string;
  relativePath: string;
  contentKind: string;
  publishedAt?: string;
  favoritedAt?: string;
  collections: string[];
}

export interface ShardResult {
  relativePath: string;
  shardKey: string;
  entries: IndexEntry[];
}

export interface GenerateIndexResult {
  shards: ShardResult[];
  entryIndex: { relativePath: string };
}

export interface GenerateIndexInput {
  config: ObsidianTargetConfig;
  vaultPath: string;
  sourceInstanceId: string;
  entries: readonly IndexEntry[];
  groupBy: readonly ('month' | 'content-type' | 'collection' | 'notebook')[];
}

/**
 * §13.8 生成分片索引。
 *
 * 按 `groupBy` 有序数组分组，每组生成一个 Markdown 分片索引。
 * 总入口只链接分片，不直接列出条目。
 */
export function generateShardIndexes(i: GenerateIndexInput): GenerateIndexResult {
  const indexDir = `${i.config.importSubdir}/${i.sourceInstanceId}/_索引`;

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
    const content = renderShardMarkdown(shardKey, shardEntries, i.config.linkStyle);
    writeShard(i.vaultPath, relativePath, content);
    shards.push({ relativePath, shardKey, entries: shardEntries });
  }

  const entryIndexRel = `${i.config.importSubdir}/${i.sourceInstanceId}/${i.sourceInstanceId}收藏索引.md`;
  const entryContent = renderEntryIndex(shards, i.sourceInstanceId);
  writeShard(i.vaultPath, entryIndexRel, entryContent);

  return { shards, entryIndex: { relativePath: entryIndexRel } };
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
): string {
  const lines: string[] = [`# ${shardKey}`, ''];
  for (const e of entries) {
    if (linkStyle === 'wikilink') {
      lines.push(`- [[${e.relativePath.replace(/\.md$/, '')}|${e.title}]]`);
    } else {
      lines.push(`- [${e.title}](${e.relativePath})`);
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

function writeShard(
  vaultPath: string,
  relativePath: string,
  content: string,
): void {
  const abs = resolveWithin(vaultPath, relativePath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}
