import type { SourceCapabilities } from '@inkmigrate/core';

/**
 * §12.1 v1.0 发布能力。
 *
 * `supportsSourceCleanup` 在 v1.0 必须为 false；v1.1 取消收藏实现并通过专项
 * 契约测试后才允许改为 true（§12.1 末尾）。程序不得根据配置文件把未实现的
 * 能力从 false 动态改为 true。
 */
export const TOUTIAO_CAPABILITIES: SourceCapabilities = {
  authMode: 'browser-profile',
  discoveryMode: 'remote-list',
  supportsIncrementalScan: true,
  supportsAssets: true,
  supportsInternalLinks: false,
  supportsSourceCleanup: false,
  cleanupActions: [],
  supportedInputFormats: [],
};
