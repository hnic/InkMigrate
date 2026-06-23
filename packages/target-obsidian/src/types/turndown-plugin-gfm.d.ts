declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  /** turndown-plugin-gfm 导出的插件函数；接受一个 TurndownService 实例并扩展它。 */
  export function gfm(service: TurndownService): void;
  export const tables: (service: TurndownService) => void;
  export const strikethrough: (service: TurndownService) => void;
  export const taskListItems: (service: TurndownService) => void;
}
