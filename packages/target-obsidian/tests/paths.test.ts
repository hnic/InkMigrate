import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateVault,
  noteRelativePath,
  noteAbsolutePath,
  assetRelativePath,
  detectLinkBase,
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
  filenameShortId: true,
  attachmentPathLayout: 'by-note',
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

describe('noteRelativePath §13.3 notePathSegments（Evernote 笔记本层级）', () => {
  it('来源目录段优先于 contentKind 目录', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'evernote-archive',
      contentKind: 'note',
      title: '会议纪要',
      stableShortId: '0f7d1a2b3c',
      notePathSegments: ['Work', 'Projects-a1b2c3d4'],
    });
    expect(p).toBe(
      'Imports/InkMigrate/evernote-archive/Work/Projects-a1b2c3d4/会议纪要-0f7d1a2b3c.md',
    );
  });
  it('无 Stack 时单层笔记本目录', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'evernote-archive',
      contentKind: 'note',
      title: '随笔',
      stableShortId: '0f7d1a2b3c',
      notePathSegments: ['Inbox-eeeeeeee'],
    });
    expect(p).toBe(
      'Imports/InkMigrate/evernote-archive/Inbox-eeeeeeee/随笔-0f7d1a2b3c.md',
    );
  });
  it('目录段逐段清洗：路径分隔符与非法字符被替换', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'evernote-archive',
      contentKind: 'note',
      title: 't',
      stableShortId: '0f7d1a2b3c',
      notePathSegments: ['../evil', 'a/b:c'],
    });
    expect(p.split('/')).not.toContain('..'); // '..-evil' 是字面目录名，安全
    expect(p.split('/').length).toBe(6); // Imports/InkMigrate/source/seg1/seg2/file
  });
  it('空数组回退 contentKind 目录（与不传一致）', () => {
    const p = noteRelativePath({
      config: baseConfig,
      sourceInstanceId: 'evernote-archive',
      contentKind: 'note',
      title: 't',
      stableShortId: '0f7d1a2b3c',
      notePathSegments: [],
    });
    expect(p).toContain('/笔记/');
  });
});


describe('自定义布局（filenameShortId / flat 附件 / 空 importSubdir）', () => {
  const custom: ObsidianTargetConfig = {
    ...baseConfig,
    importSubdir: '',
    attachmentsSubdir: 'Attachments',
    attachmentPathLayout: 'flat',
    filenameShortId: false,
  };
  it('importSubdir 空 + 无 shortId：笔记位于 <source>/<目录段>/<标题>.md', () => {
    const p = noteRelativePath({
      config: custom,
      sourceInstanceId: 'evernote-archive',
      contentKind: 'note',
      title: '不要让苹果手机镜头成为摆设',
      stableShortId: '22789a4ac1',
      notePathSegments: ['灵感'],
    });
    expect(p).toBe('evernote-archive/灵感/不要让苹果手机镜头成为摆设.md');
  });
  it('flat 附件：<Attachments>/<文件名>，无来源/条目层级', () => {
    const p = assetRelativePath({
      config: custom,
      sourceInstanceId: 'evernote-archive',
      itemKey: 'im-0123456789abcdef',
      filename: '照片.png',
    });
    expect(p).toBe('Attachments/照片.png');
  });
  it('by-note 默认布局不受影响', () => {
    const p = assetRelativePath({
      config: baseConfig,
      sourceInstanceId: 'evernote-archive',
      itemKey: 'im-0123456789abcdef',
      filename: '照片.png',
    });
    expect(p).toBe('Attachments/InkMigrate/evernote-archive/im-0123456789abcdef/照片.png');
  });
  it('importSubdir 空时索引目录仍含来源段（与 index-generator 语义一致）', () => {
    const p = noteRelativePath({
      config: { ...baseConfig, importSubdir: '' },
      sourceInstanceId: 'toutiao-main',
      contentKind: 'article',
      title: '标题',
      stableShortId: 'aaaaaaaaaa',
    });
    expect(p).toBe('toutiao-main/文章/标题-aaaaaaaaaa.md');
  });
});

describe('detectLinkBase（vaultPath 相对 Obsidian vault 根的前缀探测）', () => {
  it('vaultPath 即 vault 根（祖先无 .obsidian）→ 空串（现行为不变）', () => {
    const root = mkdtempSync(join(tmpdir(), 'ig-root-'));
    expect(detectLinkBase(root)).toBe('');
  });

  it('vaultPath 是 vault 子文件夹 → 单段前缀', () => {
    const root = mkdtempSync(join(tmpdir(), 'ig-sub-'));
    mkdirSync(join(root, '.obsidian'));
    mkdirSync(join(root, 'toutiao'));
    expect(detectLinkBase(join(root, 'toutiao'))).toBe('toutiao');
  });

  it('多层嵌套 → 多段前缀；vault 根自身返回空串（自己的 .obsidian 不算祖先）', () => {
    const root = mkdtempSync(join(tmpdir(), 'ig-deep-'));
    mkdirSync(join(root, '.obsidian'));
    mkdirSync(join(root, 'toutiao', 'deep'), { recursive: true });
    expect(detectLinkBase(join(root, 'toutiao', 'deep'))).toBe('toutiao/deep');
    expect(detectLinkBase(root)).toBe('');
  });
});
