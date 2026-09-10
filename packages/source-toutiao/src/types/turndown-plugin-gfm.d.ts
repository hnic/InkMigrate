declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  /** turndown-plugin-gfm 插件：接收 TurndownService 实例并注册 GFM 规则。 */
  type GfmPlugin = (service: TurndownService) => void;
  export const gfm: GfmPlugin;
  export const tables: GfmPlugin;
  export const strikethrough: GfmPlugin;
  export const taskListItems: GfmPlugin;
  export const highlightedCodeBlock: GfmPlugin;
}
