import type { SourceCapabilities } from '@inkmigrate/core';

/**
 * §15.1 Evernote 来源适配器能力。
 *
 * 能力只反映已实现并通过测试的功能（§8.1）：ENEX + HTML 导出（§15.12）。
 * - supportsInternalLinks=true：内部链接以原始 evernote:// 链接保留并记录
 *   （ENEX 不含 GUID 映射，跨笔记重写需 API 数据，暂不实现）。
 */
export const EVERNOTE_CAPABILITIES: SourceCapabilities = {
  authMode: 'file',
  discoveryMode: 'file-stream',
  supportsIncrementalScan: false,
  supportsAssets: true,
  supportsInternalLinks: true,
  supportsSourceCleanup: false,
  cleanupActions: [],
  supportedInputFormats: ['enex', 'html'],
};

export const SOURCE_EVERNOTE_KIND = 'evernote' as const;
export const SOURCE_EVERNOTE_VERSION = '0.1.0' as const;
export const SOURCE_EVERNOTE_ADAPTER_API_VERSION = '1.0.0' as const;
