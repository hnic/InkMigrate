import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { stringifyFrontmatter } from '../src/frontmatter.js';
import { makeFullArticleItem, makeDegradedItem } from './helpers/fixtures.js';
import { computeStableKey } from '@inkmigrate/core';

describe('stringifyFrontmatter (§13.5 精简模式)', () => {
  const item = makeFullArticleItem();
  const stableKey = computeStableKey(
    item.ref.sourceInstanceId,
    item.ref.fingerprint,
  );

  it('produces --- delimited YAML with title, source_url and M8 stable provenance fields', () => {
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
    const parsed = parse(fm.slice(4, -4));
    expect(parsed.title).toBe('人工智能如何改变软件开发');
    expect(parsed.source_url).toBe('https://www.toutiao.com/article/7428193012345678901/');
    // M8: 仅稳定溯源字段（不随 resume 变化）
    expect(parsed.source_content_hash).toBe('sha256:abc');
    expect(parsed.inkmigrate_id).toBe(stableKey);
  });

  it('M8: never writes migration_job_id / imported_at (would break targetContentHash idempotency on resume)', () => {
    // migration_job_id 在 resume 时变化、importedAt 随 plan 时间变化——若写入 frontmatter
    // 会进入 renderedContent → targetContentHash 变化 → 幂等检测失效（误判重写）。
    const fm = stringifyFrontmatter({
      item,
      stableKey,
      migrationJobId: 'mig-20260622-143000-a81f',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    expect(fm).not.toContain('migration_job_id');
    expect(fm).not.toContain('imported_at');
    // 其余被移除的字段不出现
    expect(fm).not.toContain('inkmigrate_version');
    expect(fm).not.toContain('source_instance');
    // §15.8/§15.9：tags/author 是提取期稳定值（M8 原则允许写入）；
    // notebook/stack 为 Evernote 专属条件字段，本 fixture 不出现
    expect(fm).not.toContain('source_notebook:');
    expect(fm).not.toContain('source_stack:');
  });

  it('§15.8/§15.9 条件字段：Evernote 条目写入 tags/author/时间/笔记本且幂等稳定', () => {
    const evernoteItem = {
      ...item,
      title: '带附件的笔记',
      tags: ['阅读', '项目/子项'],
      author: '张三',
      createdAt: '2019-05-03T08:20:00Z',
      updatedAt: '2025-11-12T16:45:00Z',
      sourceMetadata: {
        notebook: 'Projects',
        stack: 'Work',
        source_url: 'https://example.com/original',
        source_type: 'web.clip',
      },
    };
    const fm = stringifyFrontmatter({
      item: evernoteItem,
      stableKey,
      migrationJobId: 'mig-x',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    const parsed = parse(fm.slice(4, -4));
    expect(parsed.tags).toEqual(['阅读', '项目/子项']);
    expect(parsed.author).toBe('张三');
    expect(parsed.created_at).toBe('2019-05-03T08:20:00Z');
    expect(parsed.updated_at).toBe('2025-11-12T16:45:00Z');
    expect(parsed.source_notebook).toBe('Projects');
    expect(parsed.source_stack).toBe('Work');
    // ref.canonicalUrl 优先；sourceMetadata.source_url 仅在无 canonicalUrl 时回填
    expect(parsed.source_url).toBe(item.ref.canonicalUrl);
    expect(parsed.source_type).toBe('web.clip');
    // 同输入重渲染逐字节一致（幂等）
    const fm2 = stringifyFrontmatter({
      item: evernoteItem,
      stableKey,
      migrationJobId: 'mig-y', // job id 变化不得影响输出
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2027-01-01T00:00:00+08:00',
    });
    expect(fm2).toBe(fm);
  });

  it('omits source_url when ref has no canonicalUrl', () => {
    const minimal = makeDegradedItem();
    // 移除 canonicalUrl
    const { canonicalUrl, ...rest } = minimal.ref;
    void canonicalUrl;
    const noUrlItem = { ...minimal, ref: rest };
    const fm = stringifyFrontmatter({
      item: noUrlItem,
      stableKey,
      migrationJobId: 'j1',
      inkmigrateVersion: 1,
      sourceContentHash: 'sha256:abc',
      importedAt: '2026-06-22T14:30:00+08:00',
    });
    const parsed = parse(fm.slice(4, -4));
    expect(parsed.title).toBeDefined();
    expect(parsed.source_url).toBeUndefined();
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
    expect(parsed.source_url).toContain('toutiao.com');
  });
});
