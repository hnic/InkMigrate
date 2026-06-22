/** §8.1 来源适配器必须公开的能力对象。能力只能反映当前安装版本中已经实现并通过契约测试的功能。 */
export interface SourceCapabilities {
  authMode: 'none' | 'browser-profile' | 'file';
  discoveryMode: 'remote-list' | 'file-stream' | 'directory';
  supportsIncrementalScan: boolean;
  supportsAssets: boolean;
  supportsInternalLinks: boolean;
  supportsSourceCleanup: boolean;
  cleanupActions: readonly string[];
  supportedInputFormats: readonly string[];
}

/**
 * 目标适配器能力声明。规格未在 §8 中以独立小节强制要求目标适配器公开能力对象，
 * 但 §13.8 索引、§13.9 覆盖策略、§13.7 链接风格等都需要目标能力发现，这里给出
 * 最小集合；阶段 2 Obsidian 适配器实现时再扩展。
 */
export interface TargetCapabilities {
  supportsIndexes: boolean;
  linkStyles: readonly ('wikilink' | 'markdown')[];
}
