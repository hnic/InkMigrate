import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { stringifyFrontmatter } from '../src/frontmatter.js';
import { makeFullArticleItem, makeDegradedItem } from './helpers/fixtures.js';
import { computeStableKey } from '@inkmigrate/core';

describe('stringifyFrontmatter (§13.5)', () => {
  const item = makeFullArticleItem();
  const stableKey = computeStableKey(
    item.ref.sourceInstanceId,
    item.ref.fingerprint,
  );

  it('produces --- delimited YAML with all required properties', () => {
    const fm = stringifyFrontmatter({
      item,
      stableKey,
      migrationJobId: 'mig-20260622-143000-a81f',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('---\n')).toBe(true);
    // 用 parse 校验结构（避免对 yaml 库的引号风格做硬编码断言）
    const parsed = parse(fm.slice(4, -4));
    expect(parsed.title).toBe('人工智能如何改变软件开发');
    expect(parsed.inkmigrate_id).toMatch(/^im:toutiao-main:/);
    expect(parsed.inkmigrate_version).toBe(1);
    expect(parsed.migration_job_id).toBe('mig-20260622-143000-a81f');
    expect(parsed.source).toBe('toutiao');
    expect(parsed.source_instance).toBe('toutiao-main');
    expect(parsed.source_type).toBe('article');
    expect(parsed.source_url).toBe('https://www.toutiao.com/article/7428193012345678901/');
    expect(parsed.source_collections).toEqual(['技术收藏']);
    expect(parsed.author).toBe('示例作者');
    expect(parsed.published_at).toBe('2025-12-20T10:35:00+08:00');
    expect(parsed.favorited_at).toBe('2026-01-04T21:13:00+08:00');
    expect(parsed.imported_at).toBe('2026-06-22T14:30:00+08:00');
    expect(Array.isArray(parsed.tags)).toBe(true);
    expect(parsed.tags).toContain('source/toutiao');
    expect(parsed.tags).toContain('type/article');
    expect(parsed.tags).toContain('status/imported');
    expect(parsed.source_content_hash).toBe('sha256:abc');
  });

  it('omits fields that are not present on the item (no fabricated dates)', () => {
    const minimal = makeFullArticleItem({
      omitBody: true,
    });
    // 进一步删除可选字段（fixtures 不暴露 per-field 删除，用 Object.assign）
    const minimalItem = Object.assign({}, minimal, {
      author: undefined,
      publishedAt: undefined,
      favoritedAt: undefined,
      summary: undefined,
    });
    // exactOptional: undefined 字段在 SourceItem 上不合法，但用于测试 stringifyFrontmatter
    // 的"省略"行为，我们构造一个真正没有这些键的对象。
    const { author, publishedAt, favoritedAt, summary, ...rest } = minimalItem;
    void author;
    void publishedAt;
    void favoritedAt;
    void summary;
    const fm = stringifyFrontmatter({
      item: rest,
      stableKey,
      migrationJobId: 'j1',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    expect(fm).not.toContain('author:');
    expect(fm).not.toContain('published_at:');
    expect(fm).not.toContain('favorited_at:');
  });

  it('always includes inkmigrate_id, inkmigrate_version, migration_job_id, source, source_instance, source_type, imported_at, source_content_hash', () => {
    const minimal = makeDegradedItem();
    const fm = stringifyFrontmatter({
      item: minimal,
      stableKey,
      migrationJobId: 'j1',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    expect(fm).toContain('inkmigrate_id:');
    expect(fm).toContain('inkmigrate_version: 1');
    expect(fm).toContain('migration_job_id:');
    expect(fm).toContain('source:');
    expect(fm).toContain('source_instance:');
    expect(fm).toContain('source_type:');
    expect(fm).toContain('imported_at:');
    expect(fm).toContain('source_content_hash:');
  });

  it('source_collections dedupes entries', () => {
    const dup = makeFullArticleItem({
      collections: ['技术收藏', '技术收藏'],
    });
    const fm = stringifyFrontmatter({
      item: dup,
      stableKey,
      migrationJobId: 'j1',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    const parsed = parse(fm.slice(4, -4));
    expect(parsed.source_collections).toEqual(['技术收藏']);
  });

  it('is valid YAML (parseable by yaml library)', () => {
    const fm = stringifyFrontmatter({
      item,
      stableKey,
      migrationJobId: 'j1',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    const body = fm.replace(/^---\n/, '').replace(/---\n$/, '');
    const parsed = parse(body);
    expect(parsed.title).toBe('人工智能如何改变软件开发');
    expect(parsed.source_collections).toEqual(['技术收藏']);
  });
});
