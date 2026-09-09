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
  // 与 config.indexGroupBy 枚举一致：'notebook' 未实现（IndexEntry 无 notebook
  // 字段，buildShardKeys 会抛错），待实现后再加入。
  groupBy: readonly ('month' | 'content-type' | 'collection')[];
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
  // 排序用码元比较而非 localeCompare：localeCompare 的 collation 依赖运行时
  // ICU 构建（small-icu vs full-icu）与系统 locale，同一输入在不同机器上
  // 顺序不同，同样会造成分片字节漂移。
  const sortedEntries = [...i.entries].sort((a, b) =>
    byCodeUnit(a.relativePath, b.relativePath),
  );

  const groups = new Map<string, IndexEntry[]>();
  for (const entry of sortedEntries) {
    // buildShardKeys 返回所有分片 key（collection 维度下，多收藏夹条目产出多个 key，
    // 确保该条目在每个所属收藏夹的分片中都出现）。其它维度各返回单个 key。
    for (const key of buildShardKeys(entry, i.groupBy)) {
      const arr = groups.get(key) ?? [];
      arr.push(entry);
      groups.set(key, arr);
    }
  }

  const usedShardPaths = new Set<string>();
  const shards: ShardResult[] = [];
  for (const [shardKey, shardEntries] of [...groups.entries()].sort((a, b) =>
    byCodeUnit(a[0], b[0]),
  )) {
    const safeName = sanitizeFilename(shardKey, { maxLength: 80 });
    const relativePath = `${indexDir}/${safeName}.md`;
    // sanitizeFilename 截断到 80 字符（maxLength）可能让两个不同 shardKey 清洗后
    // 落到同一文件名，后写会静默覆盖前一分片、条目索引却仍列出两个分片——
    // 显式抛错，避免索引数据静默丢失。
    if (usedShardPaths.has(relativePath)) {
      throw new Error(
        `index-generator: shard filename collision after sanitize: "${shardKey}" -> ${relativePath}`,
      );
    }
    usedShardPaths.add(relativePath);
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
  // R7/M-5: renderEntryIndex 尊重 linkStyle。entryDir 必须是入口文件的父目录
  // （<importSubdir>/<src>），而非 indexDir（<importSubdir>/<src>/_索引）——
  // 入口文件与 _索引 是兄弟关系，markdown 相对链接需从入口文件位置算起。
  const entryDir = dirname(entryIndexRel);
  const entryContent = renderEntryIndex(shards, safeSourceId, i.config.linkStyle, entryDir);
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

/**
 * 为一个 entry 生成所有应归属的分片 key。
 * - collection 维度：条目属多个收藏夹时，为每个收藏夹生成一个 key（条目出现在每个
 *   所属收藏夹的分片中）。无收藏夹则归入"未分组"。
 * - 其它维度各产出单个值。
 * - 多维度组合时，collection 维度可能展开为多个 key（笛卡尔积），其它维度单值。
 */
function buildShardKeys(
  entry: IndexEntry,
  groupBy: readonly string[],
): string[] {
  // 每个维度产出该维度的一组候选值（通常 1 个，collection 可能多个）
  const dimValues: string[][] = [];
  for (const dim of groupBy) {
    if (dim === 'month') {
      const date = entry.favoritedAt ?? entry.publishedAt ?? '';
      // R10: 校验月份合法性（01-12），避免源数据异常（如 2025-13）产出非法分片名
      const m = /^(\d{4})-(\d{2})/.exec(date);
      if (m) {
        const month = parseInt(m[2]!, 10);
        if (month >= 1 && month <= 12) {
          dimValues.push([`${m[1]}-${m[2]}`]);
        } else {
          dimValues.push(['未知日期']);
        }
      } else {
        dimValues.push(['未知日期']);
      }
    } else if (dim === 'content-type') {
      dimValues.push([entry.contentKind]);
    } else if (dim === 'collection') {
      // §多收藏夹：条目属多个收藏夹时，每个收藏夹各产出一个 key，
      // 使条目出现在每个所属收藏夹的分片中。无收藏夹 → "未分组"。
      dimValues.push(entry.collections.length > 0 ? entry.collections : ['未分组']);
    } else {
      // 防御：config schema 已限制枚举，新增维度必须在此实现，
      // 否则该维度会被静默忽略，所有条目落入错误分片。
      throw new Error(
        `buildShardKeys: unsupported groupBy dimension "${dim}" (add implementation or extend schema)`,
      );
    }
  }
  // 笛卡尔积：其它维度单值，collection 展开为多条
  // 例：groupBy=['content-type','collection']，entry 属 [技术, 收藏A, 收藏B]
  //   → [article-技术, article-收藏A, article-收藏B]
  return cartesianProduct(dimValues).map((parts) => parts.join('-') || '全部');
}

/** 码元（UTF-16）比较：跨运行时/ICU 确定的全序，供字节级幂等排序使用。 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 笛卡尔积：每组取一个元素的所有组合。空输入返回 [[]]（单个空 key）。 */
function cartesianProduct(groups: readonly string[][]): string[][] {
  if (groups.length === 0) return [[]];
  let result: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const prefix of result) {
      for (const val of group) {
        next.push([...prefix, val]);
      }
    }
    result = next;
  }
  return result;
}

/**
 * 统一构造索引里的单条链接（分片 → 条目、入口 → 分片共用），避免两处
 * wikilink/markdown 分支逻辑重复漂移。
 *
 * 标题与文件名来自来源数据，可能含空格、括号、`[`/`]`/`|` 等会破坏链接语法的
 * 字符（sanitizeFilename 不替换 `[` `]`，空格在文件名中完全合法）：
 * - markdown：标签转义 `\`/`[`/`]`（CommonMark 反斜杠转义）；目标含空格时用
 *   `<...>` 包裹，否则 `Screenshot (1).png` 这类路径会把链接截断；路径分隔符
 *   归一化为 `/`（path.relative 在 Windows 上产出 `\`）。
 * - wikilink：目标为 Vault 相对路径（空格合法），别名剔除 `[`/`]`/`|`
 *   （wikilink 内无法转义这些字符，与 body.ts 的链接文字清洗一致）。
 */
function formatIndexLink(
  label: string,
  targetRelPath: string,
  fromDir: string,
  linkStyle: 'wikilink' | 'markdown',
): string {
  if (linkStyle === 'wikilink') {
    const target = targetRelPath.replace(/\.md$/, '');
    const alias = label.replace(/[[\]|]/g, '');
    return alias.length > 0 ? `- [[${target}|${alias}]]` : `- [[${target}]]`;
  }
  const rel = relative(fromDir, targetRelPath).split('\\').join('/');
  const url = /\s/.test(rel) ? `<${rel}>` : rel;
  return `- [${label.replace(/([\\[\]])/g, '\\$1')}](${url})`;
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
    lines.push(formatIndexLink(e.title, e.relativePath, shardDir, linkStyle));
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
    lines.push(formatIndexLink(shard.shardKey, shard.relativePath, entryDir, linkStyle));
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
 *    必须从 listIndexArtifactsByTarget 正确传入 knownIndexArtifacts（R6 已修正其 != null 过滤）。
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

  // §13.2 符号链接逃逸防护：先建目录链，再对【父目录】解引用确认位于 Vault 内。
  // 用 core 的统一 assertWriteDirSafe，与其它写入点保持一致语义（L3）。
  // 必须先于下方冲突检测的读取：resolveWithin 不解引用符号链接，若先读后校验，
  // 目录链中的逃逸符号链接会让【读取】（而非写入）绕过防护读到 Vault 外内容。
  const parentDir = dirname(abs);
  mkdirSync(parentDir, { recursive: true });
  assertWriteDirSafe(vaultPath, abs);

  // §13.8 重跑保护：已有文件 + 用户改过 → 保留用户内容，不覆写
  if (recordedHash !== undefined && existsSync(abs)) {
    // 直接按字节读取，与 atomicWriteRaw 返回的 writtenFileHash(Buffer.from(
    // content,'utf8')) 严格对应；utf8 字符串往返会把非 UTF-8 字节替换为
    // U+FFFD，造成"用户改过"的误判。
    const onDisk = writtenFileHash(readFileSync(abs));
    if (onDisk !== recordedHash) {
      // 用户修改过：跳过覆写，返回磁盘原哈希
      return { hash: onDisk, skipped: true };
    }
  }

  // I17: 用 atomicWriteRaw（temp + rename）而非直接 writeFileSync。
  // 进程被杀时直接写会留下半截损坏文件，且重跑保护会把它当"用户改过 → 跳过覆写"
  // → 数据损坏被幂等性逻辑固化。atomicWriteRaw 失败只丢 tmp，目标文件要么旧要么新。
  const hash = atomicWriteRaw(abs, content, vaultPath);
  return { hash, skipped: false };
}
