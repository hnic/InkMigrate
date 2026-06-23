import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateShardIndexes, type IndexEntry } from '../src/indexes/index-generator.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
});
