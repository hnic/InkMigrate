export {
  createEvernoteSource,
  lastScanIssues,
  type EnexRefMetadata,
} from './adapters/adapter.js';
export type { EnexFileInfo, ProcessedResource } from './adapters/adapter.js';
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
export {
  collectEnexFiles,
  splitStackNotebook,
  resolveInputPaths,
  EvernoteNotesRejectedError,
} from './enex/scan.js';
export {
  streamNotes,
  enexTimeToIso,
  type RawNote,
  type RawResource,
} from './enex/sax-notes.js';
export { buildNoteIdentity } from './enex/identity.js';
export {
  processResources,
  decodeBase64Strict,
  sniffMime,
  assetKindOf,
  extForMime,
  enexResourceUri,
} from './resources/process-resources.js';
export { enmlToHtml, sanitizeNoteHtml, type ResourceRefInfo, type EnmlTransformResult } from './enml/enml-to-html.js';
export {
  scanHtmlNote,
  extractHtmlNote,
  extractTitleFromHtml,
  evernoteResourceUri,
  type HtmlNoteHeader,
  type HtmlExtractResult,
} from './html/html-export.js';
export type { HtmlRefMetadata } from './adapters/adapter.js';
