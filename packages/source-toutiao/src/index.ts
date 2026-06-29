export {
  createToutiaoSource,
  buildRefFromFavorite,
  stableKeyForRef,
  type ToutiaoBrowserAdapterConfig,
} from './adapters/adapter.js';
export {
  SOURCE_TOUTIAO_KIND,
  SOURCE_TOUTIAO_VERSION,
  SOURCE_TOUTIAO_ADAPTER_API_VERSION,
} from './adapters/adapter.js';
export { TOUTIAO_CAPABILITIES } from './capabilities.js';
export {
  ToutiaoSourceConfigSchema,
  type ToutiaoSourceConfig,
} from './config.js';
export { runSafetyPipeline } from './pipeline/pipeline.js';
export { extractDetail } from './extract/detail-extractor.js';
export { scanFavoritesList, DEFAULT_MAX_EMPTY_CYCLES } from './scan/scanner.js';
export {
  canonicalizeToutiaoUrl,
  extractToutiaoContentId,
} from './normalize/url.js';
// 注意：resolveShortLink / needsShortLinkResolution（normalize/short-link-resolver.ts）
// 是为字母数字 /is/ 短链准备的防御性预留，当前收藏列表 DOM 不出现 /is/，业务管线
// 未接入，故不从包公共 API 导出，避免误导维护者以为重定向跟随已生效。
// 需要时可直接从 './normalize/short-link-resolver.js' 深路径导入。
export { detectContentKind } from './normalize/content-kind.js';
export { deriveFingerprintInput } from './normalize/fingerprint.js';
export {
  validateConfirmation,
  buildConfirmationPrompt,
} from './cleanup/confirmation.js';
export {
  runCleanupUnfavorite,
  type CleanupOrchestratorOptions,
  type CleanupOrchestratorResult,
  type CleanupProgress,
  type CleanupLogEntry,
} from './cleanup/cleanup-orchestrator.js';
export {
  detectLoginState,
  type LoginState,
  type LoginSignals,
} from './auth/login-detector.js';
export { profilePath, profileExists, ensureProfileDir } from './auth/profile.js';
export { downloadImage } from './assets/image-downloader.js';
export {
  ToutiaoBrowserSession,
  type BrowserSessionConfig,
  driveScanFavorites,
  type ScanDriverOptions,
  type ScanDriverResult,
  driveExtractDetail,
  type ExtractDriverOptions,
  runLoginFlow,
  type LoginFlowOptions,
  type LoginFlowResult,
} from './browser/index.js';
