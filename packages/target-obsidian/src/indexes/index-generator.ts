import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { assertWriteDirSafe, writtenFileHash, resolveWithin, sanitizeFilename } from '@inkmigrate/core';
import { atomicWriteRaw } from '../atomic-write.js';
import { sanitizePathSegment } from '../paths.js';
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
  // L10: sourceInstanceId 走 sanitizePathSegment 清洗（与 paths.ts 的 note/asset
  // 路径一致），避免含 / 的 sourceInstanceId 注入额外路径段。原直接拼接，不一致。
  const safeSourceId = sanitizePathSegment(i.sourceInstanceId);
  // 路径段用数组 + filter(Boolean).join('/') 拼接：importSubdir 为空时自动跳过该段，
  // 绝不产生以 '/' 开头的绝对路径（否则 resolveWithin 判定 escapes root）。
  const indexDir = [i.config.importSubdir, safeSourceId, '_索引']
    .filter(Boolean)
    .join('/');
  const knownByPath = new Map((i.knownArtifacts ?? []).map((a) => [a.relativePath, a.writtenFileHash]));

  // I18: 分片内条目按 relativePath 稳定排序后再分组，保证字节级幂等。
  // 否则两次 Job 以不同顺序喂入条目（DB 查询无 ORDER BY、并发收集）会让分片字节
  // 不同，导致重跑无谓改写所有分片、writtenFileHash 抖动，破坏 §13.8"可重复生成"。
  const sortedEntries = [...i.entries].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );

  const groups = new Map<string, IndexEntry[]>();
  for (const entry of sortedEntries) {
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

  // 同 indexDir：数组拼接避免空 importSubdir 产生绝对路径
  // L10: 用 safeSourceId 保持一致
  const entryIndexRel = [i.config.importSubdir, safeSourceId, `${sanitizeFilename(safeSourceId)}收藏索引.md`]
    .filter(Boolean)
    .join('/');
  // R7: renderEntryIndex 尊重 linkStyle（原始终终用 wikilink，与 shard 渲染不一致）
  const entryContent = renderEntryIndex(shards, safeSourceId, i.config.linkStyle, indexDir);
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
      // R10: 校验月份合法性（01-12），避免源数据异常（如 2025-13）产出非法分片名
      const m = /^(\d{4})-(\d{2})/.exec(date);
      if (m) {
        const month = parseInt(m[2]!, 10);
        if (month >= 1 && month <= 12) {
          parts.push(`${m[1]}-${m[2]}`);
        } else {
          parts.push('未知日期');
        }
      } else {
        parts.push('未知日期');
      }
    } else if (dim === 'content-type') {
      parts.push(entry.contentKind);
    } else if (dim === 'collection') {
      parts.push(entry.collections[0] ?? '未分组');
    } else {
      // 防御：config schema 已限制枚举，新增维度必须在此实现，
      // 否则该维度会被静默忽略，所有条目落入错误分片。
      throw new Error(
        `buildShardKey: unsupported groupBy dimension "${dim}" (add implementation or extend schema)`,
      );
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
      // markdown 链接按当前分片文件所在目录解析；用相对路径避免 404。
      // path.relative 在 Windows 上产出反斜杠分隔符（..\..\），而 Markdown 链接
      // 必须用正斜杠（跨平台渲染器仅认 /），故统一归一化为正斜杠。
      const rel = relative(shardDir, e.relativePath).split('\\').join('/');
      lines.push(`- [${e.title}](${rel})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderEntryIndex(
  shards: readonly ShardResult[],
  sourceInstanceId: string,
  linkStyle: 'wikilink' | 'markdown',
  /** entry index 文件所在目录（相对 Vault 根），用于 markdown 链接的相对路径计算。 */
  entryDir: string,
): string {
  const lines: string[] = [
    `# ${sourceInstanceId} 收藏索引`,
    '',
    '> 本文件由 InkMigrate 自动生成，请勿手动编辑。',
    '',
  ];
  for (const shard of shards) {
    if (linkStyle === 'wikilink') {
      const link = shard.relativePath.replace(/\.md$/, '');
      lines.push(`- [[${link}|${shard.shardKey}]]`);
    } else {
      // R7: markdown 模式用相对路径（entry 文件与 shard 文件的相对位置），
      // 与 renderShardMarkdown 一致，归一化正斜杠。
      const rel = relative(entryDir, shard.relativePath).split('\\').join('/');
      lines.push(`- [${shard.shardKey}](${rel})`);
    }
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
 *    R8（契约约束）：重跑保护仅在 recordedHash 非 null 时生效。调用方（job-runner）
 *    必须从 listIndexArtifacts 正确传入 knownIndexArtifacts（R6 已修正其 != null 过滤）。
 *    若未来新增调用方未传入，首次写入会跳过用户修改检测——新增调用方务必传入。
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
  // 用 core 的统一 assertWriteDirSafe，与其它写入点保持一致语义（L3）。
  const parentDir = dirname(abs);
  mkdirSync(parentDir, { recursive: true });
  assertWriteDirSafe(vaultPath, abs);
  // I17: 用 atomicWriteRaw（temp + rename）而非直接 writeFileSync。
  // 进程被杀时直接写会留下半截损坏文件，且重跑保护会把它当"用户改过 → 跳过覆写"
  // → 数据损坏被幂等性逻辑固化。atomicWriteRaw 失败只丢 tmp，目标文件要么旧要么新。
  const hash = atomicWriteRaw(abs, content, vaultPath);
  return { hash, skipped: false };
}
