import type { SourceCapabilities } from '@inkmigrate/core';

/**
 * §12.1 v1.1 发布能力。
 *
 * v1.1 阶段 6 完成后启用 `supportsSourceCleanup: true`。
 */
export const TOUTIAO_CAPABILITIES: SourceCapabilities = {
  authMode: 'browser-profile',
  discoveryMode: 'remote-list',
  supportsIncrementalScan: true,
  supportsAssets: true,
  supportsInternalLinks: false,
  supportsSourceCleanup: true,
  cleanupActions: ['unfavorite'],
  supportedInputFormats: [],
};
