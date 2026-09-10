/**
 * 包公共出口（收敛为真实公共面）：适配器工厂、诊断、配置 schema 与
 * ref-metadata 类型。管线内部工具（base64/MIME 嗅探/ENML 转换/HTML 解析等）
 * 不在此导出——包为 private，仓库内测试与子模块经深路径引用，
 * 暴露内部实现细节只会让后续演化变成不必要的破坏面。
 */
export {
  createEvernoteSource,
  lastScanIssues,
  type EnexRefMetadata,
  type HtmlRefMetadata,
} from './adapters/adapter.js';
export {
  SOURCE_EVERNOTE_KIND,
  SOURCE_EVERNOTE_VERSION,
  SOURCE_EVERNOTE_ADAPTER_API_VERSION,
  EVERNOTE_CAPABILITIES,
} from './capabilities.js';
export {
  EvernoteSourceConfigSchema,
  parseEvernoteConfig,
  type EvernoteSourceConfig,
} from './config.js';
export { EvernoteNotesRejectedError } from './enex/scan.js';
// 类型从定义模块直接导出（不经 adapter 转手），类型出处一目了然
export type { EnexFileInfo } from './enex/scan.js';
export type { ProcessedResource } from './resources/process-resources.js';
