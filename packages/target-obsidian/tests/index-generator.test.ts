import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateShardIndexes, type IndexEntry } from '../src/indexes/index-generator.js';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObsidianTargetConfig } from '../src/config.js';

const config: ObsidianTargetConfig = {
  vaultPath: '/vault',
  importSubdir: 'Imports/InkMigrate',
  attachmentsSubdir: 'Attachments/InkMigrate',
  linkStyle: 'wikilink',
  overwritePolicy: 'preserve',
  collectionMapping: { toTags: false, toFolders: false },
  maxFilenameLength: 100,
};

const entries: IndexEntry[] = [
  { title: '文章1', relativePath: 'Imports/InkMigrate/s1/文章/文章1-abc.md', contentKind: 'article', publishedAt: '2026-01-15T10:00:00+08:00', favoritedAt: '2026-01-16T12:00:00+08:00', collections: ['技术'] },
  { title: '文章2', relativePath: 'Imports/InkMigrate/s1/文章/文章2-def.md', contentKind: 'article', publishedAt: '2026-02-20T10:00:00+08:00', favoritedAt: '2026-02-21T12:00:00+08:00', collections: ['随笔'] },
  { title: '视频1', relativePath: 'Imports/InkMigrate/s1/视频/视频1-ghi.md', contentKind: 'video', publishedAt: '2026-01-10T10:00:00+08:00', favoritedAt: '2026-01-11T12:00:00+08:00', collections: ['技术'] },
];

describe('generateShardIndexes (§13.8)', () => {
  let vault: string;
  beforeEach(() => (vault = mkdtempSync(join(tmpdir(), 'idx-vault-'))));
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('generates month+content-type shards', () => {
    const result = generateShardIndexes({
      config,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['month', 'content-type'],
    });
    expect(result.shards.length).toBeGreaterThan(0);
    expect(result.entryIndex).toBeDefined();
    expect(result.shards.every((s) => s.relativePath.endsWith('.md'))).toBe(true);
  });

  it('writes shard files to vault', () => {
    const result = generateShardIndexes({
      config,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['month', 'content-type'],
    });
    for (const shard of result.shards) {
      const abs = join(vault, shard.relativePath);
      expect(existsSync(abs)).toBe(true);
      const content = readFileSync(abs, 'utf8');
      expect(content).toContain('# ');
    }
  });

  it('entry index links shards, not entries', () => {
    const result = generateShardIndexes({
      config,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['content-type'],
    });
    const entryAbs = join(vault, result.entryIndex.relativePath);
    const content = readFileSync(entryAbs, 'utf8');
    expect(content).toContain('_索引');
  });

  it('idempotent: re-running produces same shard set', () => {
    const opts = { config, vaultPath: vault, sourceInstanceId: 's1', entries, groupBy: ['content-type'] as const };
    const r1 = generateShardIndexes(opts);
    const r2 = generateShardIndexes(opts);
    expect(r2.shards.map((s) => s.relativePath).sort()).toEqual(
      r1.shards.map((s) => s.relativePath).sort(),
    );
  });

  it('markdown 链接使用相对 _索引/ 的相对路径（§缺陷4 防 404 失效）', () => {
    // §缺陷4：索引文件位于 <importSubdir>/<src>/_索引/ 下，直接拼 e.relativePath
    // （Vault 根相对路径，如 Imports/.../文章/x.md）会让 Markdown 渲染器按
    // 当前 _索引/ 目录解析，变成 _索引/Imports/.../文章/x.md → 404。
    // 修正后应用 path.relative 计算到目标文章的真正相对路径（以 ../ 开头）。
    const markdownConfig: ObsidianTargetConfig = { ...config, linkStyle: 'markdown' };
    const result = generateShardIndexes({
      config: markdownConfig,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['content-type'],
    });
    const shardAbs = join(vault, result.shards[0]!.relativePath);
    const content = readFileSync(shardAbs, 'utf8');
    // 每条 markdown 链接应相对当前分片文件（位于 _索引/ 下），即以 ../ 开头，
    // 而非指向 Vault 根的 Imports/... 绝对路径。
    const mdLinkLine = content
      .split('\n')
      .find((l) => /^\- \[[^\]]+\]\(([^)]+)\)/.test(l));
    expect(mdLinkLine).toBeDefined();
    const href = /^\- \[[^\]]+\]\(([^)]+)\)/.exec(mdLinkLine!)![1];
    expect(href.startsWith('../')).toBe(true);
    expect(href).not.toContain('_索引/');
    // 跨平台回归（CI Windows 失败 #14）：path.relative 在 Windows 上产出反斜杠分隔符
    // （..\..\），而 Markdown 链接渲染只认正斜杠 → 404。归一化后 href 不得含反斜杠。
    expect(href).not.toMatch(/\\/);
  });

  it('每个分片/总入口返回 writtenFileHash（用于 artifact 追踪 + 重跑保护）', () => {
    const result = generateShardIndexes({
      config,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['content-type'],
    });
    for (const shard of result.shards) {
      expect(shard.writtenFileHash).toBeDefined();
      expect(typeof shard.writtenFileHash).toBe('string');
    }
    expect(result.entryIndex.writtenFileHash).toBeDefined();
  });

  it('重跑保护：用户手改过的分片不被覆写（§13.8 可重复生成且不覆盖用户笔记）', () => {
    // 第一轮生成 → 落库 writtenFileHash
    const opts = { config, vaultPath: vault, sourceInstanceId: 's1', entries, groupBy: ['content-type'] as const };
    const r1 = generateShardIndexes(opts);
    const shard0 = r1.shards[0]!;
    const shardAbs = join(vault, shard0.relativePath);
    const recordedHash = shard0.writtenFileHash!;

    // 用户手动编辑该分片（on-disk 哈希与 recordedHash 不符）
    writeFileSync(shardAbs, readFileSync(shardAbs, 'utf8') + '\n\n用户批注', 'utf8');

    // 第二轮：传入 recordedHash → 检测到用户修改 → 跳过覆写该分片
    const r2 = generateShardIndexes({
      ...opts,
      knownArtifacts: [{ relativePath: shard0.relativePath, writtenFileHash: recordedHash }],
    });
    const modified = r2.shards.find((s) => s.relativePath === shard0.relativePath)!;
    // 用户内容原样保留
    expect(readFileSync(shardAbs, 'utf8')).toContain('用户批注');
    // 该分片被标记为冲突跳过（未被覆写）
    expect(modified.skippedDueToConflict).toBe(true);
  });

  it('重跑保护：未修改的分片正常覆写更新', () => {
    const opts = { config, vaultPath: vault, sourceInstanceId: 's1', entries, groupBy: ['content-type'] as const };
    const r1 = generateShardIndexes(opts);
    const shard0 = r1.shards[0]!;
    const shardAbs = join(vault, shard0.relativePath);
    // 第二轮：hash 匹配 → 正常覆写（无 skippedDueToConflict）
    const r2 = generateShardIndexes({
      ...opts,
      knownArtifacts: [{ relativePath: shard0.relativePath, writtenFileHash: shard0.writtenFileHash! }],
    });
    const same = r2.shards.find((s) => s.relativePath === shard0.relativePath)!;
    expect(same.skippedDueToConflict).toBeFalsy();
    expect(readFileSync(shardAbs, 'utf8').length).toBeGreaterThan(0);
  });

  it('importSubdir 为空时索引不产生绝对路径（不 escapes root）', () => {
    // 回归场景：CLI migrate 默认 importSubdir=''（笔记直接放 Vault 根）。
    // 此前 indexDir/entryIndexRel 无条件拼 `${importSubdir}/...`，
    // 空字符串产生以 / 开头的绝对路径 → resolveWithin 判定 escapes root → 报错。
    const rootConfig: ObsidianTargetConfig = {
      ...config,
      importSubdir: '',
    };
    // importSubdir='' 时笔记路径就是裸文件名（见 noteRelativePath）
    const rootEntries: IndexEntry[] = [
      { title: '文章1', relativePath: '文章1-abc.md', contentKind: 'article', publishedAt: '2026-01-15T10:00:00+08:00', favoritedAt: '2026-01-16T12:00:00+08:00', collections: [] },
      { title: '文章2', relativePath: '文章2-def.md', contentKind: 'article', publishedAt: '2026-02-20T10:00:00+08:00', favoritedAt: '2026-02-21T12:00:00+08:00', collections: [] },
    ];
    // 修复前：抛 path "..." escapes root（因 indexDir 以 / 开头）
    // 修复后：索引落在 Vault 内的合理相对路径，正常生成
    const result = generateShardIndexes({
      config: rootConfig,
      vaultPath: vault,
      sourceInstanceId: 'toutiao-main',
      entries: rootEntries,
      groupBy: ['month', 'content-type'],
    });
    expect(result.shards.length).toBeGreaterThan(0);
    // 所有 shard 路径必须是相对路径（不以 / 开头）
    expect(result.shards.every((s) => !s.relativePath.startsWith('/'))).toBe(true);
    expect(!result.entryIndex.relativePath.startsWith('/')).toBe(true);
    // shard 文件实际写入 Vault（在 Vault 根的 _索引/ 子目录下）
    const shardAbs = join(vault, result.shards[0]!.relativePath);
    expect(existsSync(shardAbs)).toBe(true);
  });

  it('R3-T4/M-5: markdown 模式入口索引链接指向 _索引/（非裸文件名，原 entryDir 错误）', () => {
    const markdownConfig: ObsidianTargetConfig = { ...config, linkStyle: 'markdown' };
    const result = generateShardIndexes({
      config: markdownConfig,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries,
      groupBy: ['content-type'],
    });
    const entryAbs = join(vault, result.entryIndex.relativePath);
    const entryContent = readFileSync(entryAbs, 'utf8');
    // 入口索引的 markdown 链接应指向 _索引/xxx.md（入口文件在 <src>/ 下，
    // 分片在 <src>/_索引/ 下，相对链接需含 _索引/ 前缀）。
    // M-5 修复前 entryDir=indexDir（_索引/），relative 算出的链接缺 _索引/ 前缀 → 404。
    const mdLinkLine = entryContent
      .split('\n')
      .find((l) => /^\- \[[^\]]+\]\(([^)]+)\)/.test(l));
    expect(mdLinkLine).toBeDefined();
    const href = /^\- \[[^\]]+\]\(([^)]+)\)/.exec(mdLinkLine!)![1];
    // 入口索引链接应包含 _索引/ 前缀（指向子目录中的分片文件）
    expect(href).toContain('_索引/');
    expect(href).not.toMatch(/\\/); // 跨平台正斜杠
  });

  it('regression: 多 collection 条目出现在每个所属收藏夹的分片中', () => {
    // 此前 collection 维度只取 entry.collections[0]，多收藏夹条目只在第一个收藏夹
    // 的分片中出现，其余收藏夹分片丢失该条目，索引完整性语义缺陷。
    const multiCollectionEntries: IndexEntry[] = [
      { title: '共享文章', relativePath: 'a/shared-xyz.md', contentKind: 'article', publishedAt: '2026-01-15T10:00:00+08:00', favoritedAt: '2026-01-16T12:00:00+08:00', collections: ['技术', '精选', '深度'] },
      { title: '随笔', relativePath: 'b/note-def.md', contentKind: 'article', publishedAt: '2026-02-20T10:00:00+08:00', favoritedAt: '2026-02-21T12:00:00+08:00', collections: ['随笔'] },
    ];
    const result = generateShardIndexes({
      config,
      vaultPath: vault,
      sourceInstanceId: 's1',
      entries: multiCollectionEntries,
      groupBy: ['collection'],
    });
    // 应产生 4 个分片（顺序无关，用集合比较）
    const shardNames = new Set(result.shards.map((s) => s.shardKey));
    expect(shardNames).toEqual(new Set(['技术', '精选', '深度', '随笔']));
    // "共享文章"应同时出现在技术、精选、深度三个分片中
    const tech = result.shards.find((s) => s.shardKey === '技术')!;
    const curated = result.shards.find((s) => s.shardKey === '精选')!;
    const deep = result.shards.find((s) => s.shardKey === '深度')!;
    expect(tech.entries.map((e) => e.title)).toContain('共享文章');
    expect(curated.entries.map((e) => e.title)).toContain('共享文章');
    expect(deep.entries.map((e) => e.title)).toContain('共享文章');
    // "随笔"只在随笔分片
    const essay = result.shards.find((s) => s.shardKey === '随笔')!;
    expect(essay.entries.map((e) => e.title)).toEqual(['随笔']);
  });
});

describe('linkBase 前缀（vaultPath 为 vault 子文件夹时的 wikilink 对齐）', () => {
  it('分片索引的条目 wikilink 带 vault 根前缀；markdown 风格不带', () => {
    const v = mkdtempSync(join(tmpdir(), 'idx-base-'));
    try {
      const wiki = generateShardIndexes({
        config, vaultPath: v, sourceInstanceId: 's1', entries, groupBy: ['month'],
        linkBase: 'toutiao',
      });
      expect(wiki.shards.length).toBeGreaterThan(0);
      for (const s of wiki.shards) {
        const content = readFileSync(join(v, s.relativePath), 'utf8');
        // 条目 wikilink 以 vault 根前缀开头（严格按 vault 根解析可命中）
        expect(content).toContain('[[toutiao/Imports/InkMigrate/s1/文章/');
      }
    } finally {
      rmSync(v, { recursive: true, force: true });
    }
  });
});
