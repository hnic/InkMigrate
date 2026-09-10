import type { SourceCapabilities } from '@inkmigrate/core';

/**
 * §12.1 v1.1 支持的清理动作——单一事实来源：
 * TOUTIAO_CAPABILITIES.cleanupActions 与 adapter.cleanup.supportedActions
 * 都引用本常量，避免两份硬编码列表静默漂移（能力声明与实现不一致会导致
 * 编排方派发适配器不认的动作，或隐藏已支持的动作）。
 */
export const TOUTIAO_CLEANUP_ACTIONS = ['unfavorite'] as const;

/**
 * §12.1 v1.1 发布能力。
 *
 * v1.1 阶段 6（源清理）已完成：`supportsSourceCleanup: true` 为有意启用，
 * 清理动作即 TOUTIAO_CLEANUP_ACTIONS（与 adapter.cleanup.supportedActions 同源）。
 */
export const TOUTIAO_CAPABILITIES: SourceCapabilities = {
  authMode: 'browser-profile',
  discoveryMode: 'remote-list',
  supportsIncrementalScan: true,
  supportsAssets: true,
  supportsInternalLinks: false,
  supportsSourceCleanup: true,
  cleanupActions: TOUTIAO_CLEANUP_ACTIONS,
  supportedInputFormats: [],
};
