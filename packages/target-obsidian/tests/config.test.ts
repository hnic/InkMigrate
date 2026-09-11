import { describe, it, expect } from 'vitest';
import { ObsidianTargetConfigSchema } from '../src/config.js';

describe('ObsidianTargetConfigSchema (§13.2/§13.7/§13.9)', () => {
  it('accepts a minimal valid config with defaults', () => {
    const cfg = ObsidianTargetConfigSchema.parse({
      vaultPath: '/vault',
    });
    expect(cfg.vaultPath).toBe('/vault');
    expect(cfg.linkStyle).toBe('wikilink');
    expect(cfg.overwritePolicy).toBe('preserve');
    expect(cfg.importSubdir).toBe('Imports/InkMigrate');
    expect(cfg.attachmentsSubdir).toBe('Attachments/InkMigrate');
    expect(cfg.maxFilenameLength).toBe(100);
    // 默认纯标题文件名（75cfaa6 口径）：GUI 无 filenameShortId 配置入口，默认值
    // 即 GUI 用户的实际行为；d8c3f7b 曾按 PRD §13.4 设回 true 导致短哈希后缀
    // 回归（2026-09-11 实际迁移文件名带 -<sha256前8位>），钉住防止再次回退
    expect(cfg.filenameShortId).toBe(false);
    expect(cfg.collectionMapping).toEqual({ toTags: false, toFolders: false });
  });

  it('accepts markdown link style and write-new policy', () => {
    const cfg = ObsidianTargetConfigSchema.parse({
      vaultPath: '/v',
      linkStyle: 'markdown',
      overwritePolicy: 'write-new',
    });
    expect(cfg.linkStyle).toBe('markdown');
    expect(cfg.overwritePolicy).toBe('write-new');
  });

  it('rejects unknown linkStyle', () => {
    expect(() =>
      ObsidianTargetConfigSchema.parse({ vaultPath: '/v', linkStyle: 'html' }),
    ).toThrow(/linkStyle/);
  });

  it('rejects unknown overwritePolicy', () => {
    expect(() =>
      ObsidianTargetConfigSchema.parse({ vaultPath: '/v', overwritePolicy: 'force' }),
    ).toThrow(/overwritePolicy/);
  });

  it('requires vaultPath', () => {
    expect(() => ObsidianTargetConfigSchema.parse({})).toThrow(/vaultPath/);
  });

  it('collectionMapping accepts partial overrides', () => {
    const cfg = ObsidianTargetConfigSchema.parse({
      vaultPath: '/v',
      collectionMapping: { toTags: true },
    });
    expect(cfg.collectionMapping.toTags).toBe(true);
    expect(cfg.collectionMapping.toFolders).toBe(false);
  });

  it('maxFilenameLength must be positive integer', () => {
    expect(() =>
      ObsidianTargetConfigSchema.parse({ vaultPath: '/v', maxFilenameLength: 0 }),
    ).toThrow();
    expect(() =>
      ObsidianTargetConfigSchema.parse({ vaultPath: '/v', maxFilenameLength: 5.5 }),
    ).toThrow();
  });

  it('strict mode rejects unknown top-level fields', () => {
    expect(() =>
      ObsidianTargetConfigSchema.parse({ vaultPath: '/v', bogus: 1 }),
    ).toThrow();
  });

  it('indexGroupBy 默认 [month, content-type]（§13.8 分片索引维度）', () => {
    const cfg = ObsidianTargetConfigSchema.parse({ vaultPath: '/v' });
    expect(cfg.indexGroupBy).toEqual(['month', 'content-type']);
  });

  it('indexGroupBy 接受有序组合（month/content-type/collection/notebook）', () => {
    const cfg = ObsidianTargetConfigSchema.parse({
      vaultPath: '/v',
      indexGroupBy: ['collection', 'month'],
    });
    expect(cfg.indexGroupBy).toEqual(['collection', 'month']);
  });

  it('indexGroupBy 拒绝非法维度', () => {
    expect(() =>
      ObsidianTargetConfigSchema.parse({
        vaultPath: '/v',
        indexGroupBy: ['author'],
      }),
    ).toThrow();
  });
});
