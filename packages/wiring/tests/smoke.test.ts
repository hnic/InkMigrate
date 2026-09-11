import { describe, it, expect } from 'vitest';
import {
  legacyTargetConfig,
  resolveTargetConfig,
} from '../src/index.js';

describe('wiring smoke', () => {
  it('legacyTargetConfig 返回平铺 Vault 布局的 9 键配置（flat + 无索引）', () => {
    expect(legacyTargetConfig('/tmp/vault')).toEqual({
      vaultPath: '/tmp/vault',
      importSubdir: '',
      attachmentsSubdir: 'Attachments',
      linkStyle: 'wikilink',
      overwritePolicy: 'preserve',
      collectionMapping: { toTags: false, toFolders: false },
      maxFilenameLength: 100,
      // 2026-09-11 用户需求：平铺根 + 不生成收藏索引（yaml config 可改回）
      notePathLayout: 'flat',
      generateIndex: false,
    });
  });

  it('配置文件不存在时回退 legacy 布局', () => {
    // 不存在的配置路径 → 无配置 → legacy（老用户路径不变）
    const cfg = resolveTargetConfig(
      '/tmp/inkmigrate-wiring-nonexistent/inkmigrate.yaml',
      'obsidian',
      '/tmp/vault',
    );
    expect(cfg.importSubdir).toBe('');
    expect(cfg.vaultPath).toBe('/tmp/vault');
  });
});
