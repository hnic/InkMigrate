import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateVault,
  noteRelativePath,
  noteAbsolutePath,
  assetRelativePath,
} from '../src/paths.js';
import type { ObsidianTargetConfig } from '../src/config.js';

const baseConfig: ObsidianTargetConfig = {
  vaultPath: '/vault',
  importSubdir: 'Imports/InkMigrate',
  attachmentsSubdir: 'Attachments/InkMigrate',
  linkStyle: 'wikilink',
  overwritePolicy: 'preserve',
  collectionMapping: { toTags: false, toFolders: false },
  maxFilenameLength: 100,
};

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'paths-vault-'));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('validateVault (§13.2)', () => {
  it('passes for an existing writable directory', () => {
    expect(() => validateVault(vault)).not.toThrow();
  });
  it('throws when vault does not exist', () => {
    expect(() => validateVault(join(vault, 'nope'))).toThrow(/exist|not found|ENOENT/i);
  });
  it('throws on traversal attempt in vaultPath', () => {
    expect(() => validateVault('../etc')).toThrow();
  });
});

describe('noteRelativePath (§13.3/§13.4)', () => {
  it('builds toutiao article path under 文章/ with <title>-<shortId>.md', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'article',
      title: '人工智能如何改变软件开发',
      stableShortId: '0f7d1a2b3c',
    });
    // §13.4 文件名格式：<title>-<stableShortId>.md
    // stableShortId 后缀保证断点续跑/重跑时同一指纹落到同一稳定路径，
    // 避免每次重跑因 pathInUse 误判而生成 -2/-3 冗余副本。
    expect(p).toBe(
      'Imports/InkMigrate/toutiao-main/文章/人工智能如何改变软件开发-0f7d1a2b3c.md',
    );
  });
  it('filename includes the stableShortId suffix', () => {
    // 显式断言：stableShortId 必须出现在文件名中（防止回归到丢弃 shortId 的实现）
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'article',
      title: '同名标题',
      stableShortId: '0f7d1a2b3c',
    });
    const filename = p.split('/').pop()!;
    expect(filename).toBe('同名标题-0f7d1a2b3c.md');
  });
  it('different stableShortIds for the same title produce distinct paths (no -N dedupe needed)', () => {
    // 这是 stableShortId 的核心价值：标题相同但指纹不同的两篇文章
    // 应天然落到不同文件，而非依赖 planNote 的 -2.md 兜底。
    const a = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'article',
      title: '同名标题',
      stableShortId: 'aaaaaaaaaa',
    });
    const b = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'article',
      title: '同名标题',
      stableShortId: 'bbbbbbbbbb',
    });
    expect(a).not.toBe(b);
  });
  it('routes short-post to 微头条/', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'short-post',
      title: '一条微头条',
      stableShortId: '0f7d1a2b3c',
    });
    expect(p).toContain('微头条/');
  });
  it('routes unknown to 未知类型/', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      contentKind: 'unknown',
      title: 'x',
      stableShortId: '0f7d1a2b3c',
    });
    expect(p).toContain('未知类型/');
  });
  it('routes gallery/question/video to correct dirs', () => {
    for (const [kind, dir] of [
      ['gallery', '图集'],
      ['question-answer', '问答'],
      ['video', '视频'],
    ] as const) {
      const p = noteRelativePath({
        config: baseConfig,
        sourceInstanceId: 'toutiao-main',
        contentKind: kind,
        title: 't',
        stableShortId: 's',
      });
      expect(p).toContain(`${dir}/`);
    }
  });
  it('source instance id appears in path', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-other',
      contentKind: 'article',
      title: 't',
      stableShortId: 's',
    });
    expect(p).toContain('toutiao-other/');
  });
  it('filename uses sanitizeFilename (illegal filename chars replaced; dir separators preserved)', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 's',
      contentKind: 'article',
      title: 'a/b:c?',
      stableShortId: '0123456789',
    });
    // check only the filename segment (last path component); dir separators are legit
    const filename = p.split('/').pop()!;
    expect(filename).not.toMatch(/[\\:*?"<>|]/);
  });
  it('filename truncated to maxFilenameLength + suffix', () => {
    const longTitle = '字'.repeat(200);
    const p = noteRelativePath({
      config: { ...baseConfig, maxFilenameLength: 20 },
      sourceInstanceId: 's',
      contentKind: 'article',
      title: longTitle,
      stableShortId: '0123456789',
    });
    const filename = p.split('/').pop()!.replace(/\.md$/, '');
    // body (title-derived) ≤ 20 chars; total includes -shortid (10) + dash
    expect(filename.length).toBeLessThanOrEqual(20 + 1 + 10);
  });
});

describe('noteAbsolutePath (§13.2 path safety)', () => {
  it('resolves relative path inside vault', () => {
    const abs = noteAbsolutePath(vault, 'Imports/InkMigrate/s/a.md');
    expect(abs).toBe(join(vault, 'Imports/InkMigrate/s/a.md'));
  });
  it('rejects relative path that escapes vault', () => {
    expect(() => noteAbsolutePath(vault, '../etc/passwd')).toThrow(/escape/);
  });
});

describe('assetRelativePath (§13.7)', () => {
  it('builds Attachments/InkMigrate/<instance>/<itemKey>/<filename>', () => {
    const p = assetRelativePath({
      config: baseConfig,
      sourceInstanceId: 'toutiao-main',
      itemKey: 'im-0123456789abcdef',
      filename: '001-cover.webp',
    });
    expect(p).toBe(
      'Attachments/InkMigrate/toutiao-main/im-0123456789abcdef/001-cover.webp',
    );
  });
  it('sanitizes filename (illegal chars replaced; dir separators preserved)', () => {
    const p = assetRelativePath({
      config: baseConfig,
      sourceInstanceId: 's',
      itemKey: 'im-0123456789abcdef',
      filename: 'a/b.webp',
    });
    const filename = p.split('/').pop()!;
    expect(filename).not.toMatch(/[\\:*?"<>|]/);
  });
});
