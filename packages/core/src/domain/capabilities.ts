/**
 * §8.1 来源适配器必须公开的能力对象。能力只能反映当前安装版本中已经实现并通过契约测试的功能。
 *
 * 不变量：`supportsSourceCleanup === (cleanupActions.length > 0)`（注册表在注册时
 * 强制校验；flag 为 false 时 cleanupActions 必须为空）。`cleanupActions` 是开放的
 * 动作词表（小写字符串，如 `'unfavorite'`），由各来源适配器声明，编排端按字符串精确匹配。
 */
export interface SourceCapabilities {
  authMode: 'none' | 'browser-profile' | 'file';
  discoveryMode: 'remote-list' | 'file-stream' | 'directory';
  supportsIncrementalScan: boolean;
  supportsAssets: boolean;
  supportsInternalLinks: boolean;
  supportsSourceCleanup: boolean;
  cleanupActions: readonly string[];
  /**
   * 规范形式：不带点的小写扩展名（如 `'enex'`、`'html'`），不是 MIME 类型。
   * 文件型来源（file-stream/directory）必须至少声明一种；remote-list 来源
   * （无文件输入）合法为空，故不强制非空。
   */
  supportedInputFormats: readonly string[];
}

/** §13.7 链接风格协商用的风格字面量。 */
export type LinkStyle = 'wikilink' | 'markdown';

/**
 * 目标适配器能力声明。规格未在 §8 中以独立小节强制要求目标适配器公开能力对象，
 * 但 §13.8 索引、§13.9 覆盖策略、§13.7 链接风格等都需要目标能力发现，这里给出
 * 最小集合；阶段 2 Obsidian 适配器实现时再扩展。
 */
export interface TargetCapabilities {
  supportsIndexes: boolean;
  /**
   * 至少包含一种风格；空数组无法满足 §13.7 的链接风格协商——用非空元组
   * 类型在编译期强制该约束，而非仅靠注释。
   */
  linkStyles: readonly [LinkStyle, ...LinkStyle[]];
}
