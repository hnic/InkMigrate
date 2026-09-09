import type { SourceCapabilities } from '@inkmigrate/core';

/**
 * §12.1 v1.1 发布能力。
 *
 * v1.1 阶段 6（源清理）已完成：`supportsSourceCleanup: true` 为有意启用，
 * 清理动作仅 `unfavorite`（与 adapter.cleanup.supportedActions 对齐）。
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
