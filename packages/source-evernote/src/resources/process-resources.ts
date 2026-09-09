import { createHash } from 'node:crypto';
import { sanitizeFilename, type SourceAsset } from '@inkmigrate/core';
import type { RawResource } from '../enex/sax-notes.js';

/**
 * §15.7 资源管线：Base64 解码校验 → Magic Bytes 判型 → 哈希 → 命名 → SourceAsset。
 *
 * - en-media 的 hash = 资源字节 MD5（§15.7.2），ENEX 不存该值，此处计算并以
 *   `enex-resource://<md5>` 合成 URI 暴露给目标端做正文匹配与本地化。
 * - 命名链（§15.7.4）：file-name（清理）→ `<三位序号>.<ext>` → 同名冲突追加
 *   `-<SHA-256 前 8 位>`；扩展名以实际字节（Magic Bytes）为准。
 * - 同笔记内相同内容（SHA-256 相同）去重（§15.7.6）。
 */

export const enexResourceUri = (md5Hex: string): string => `enex-resource://${md5Hex}`;

/** Magic Bytes 判型（§15.7.3，与 §12.10 同源规则）。 */
export function sniffMime(bytes: Uint8Array): string | null {
  const startsWith = (prefix: number[], offset = 0) =>
    prefix.every((b, idx) => bytes[offset + idx] === b);
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

const OFFICE_MIME_PREFIXES = [
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument',
  'application/vnd.oasis.opendocument',
] as const;

export function assetKindOf(mime: string): SourceAsset['kind'] {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (OFFICE_MIME_PREFIXES.some((p) => mime.startsWith(p))) return 'office';
  return 'other';
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? 'bin';
}

/** 严格 Base64 校验（§15.7.3）：剥离空白后必须匹配字母表且填充合法。 */
export type Base64DecodeResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

export function decodeBase64Strict(b64Text: string): Base64DecodeResult {
  const compact = b64Text.replace(/\s+/g, '');
  if (compact.length === 0) return { ok: false, error: 'empty base64 payload' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    return { ok: false, error: 'base64 contains illegal characters' };
  }
  if (compact.length % 4 !== 0) return { ok: false, error: 'base64 length not a multiple of 4' };
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const expectedLen = (compact.length / 4) * 3 - padding;
  const bytes = Buffer.from(compact, 'base64');
  // 防御：Node 解码器对非法字符静默忽略，长度对不上时按解码失败处理
  if (bytes.length !== expectedLen) return { ok: false, error: 'base64 decoded length mismatch' };
  return { ok: true, bytes };
}

export interface ProcessedResource {
  md5Hex: string;
  sha256Hex: string;
  /** Magic Bytes 判定的实际类型；无法识别时回退声明 MIME。 */
  actualMime: string;
  declaredMime: string;
  /** 声明与实际不一致（记入报告）。 */
  mimeMismatch: boolean;
  attachment: boolean;
  fileName: string;
  /** 未被正文引用的资源（en-media 无匹配时由调用方结合转换结果判定）。 */
  asset: SourceAsset;
}

export interface ResourceFailure {
  index: number;
  reason: string;
}

export interface ProcessResourcesResult {
  resources: ProcessedResource[];
  failures: ResourceFailure[];
  /** 同笔记内重复内容（SHA-256 相同）被丢弃的数量。 */
  duplicates: number;
  mimeMismatches: number;
}

export function processResources(
  raws: readonly RawResource[],
  opts: { maxResourceBytes: number },
): ProcessResourcesResult {
  const resources: ProcessedResource[] = [];
  const failures: ResourceFailure[] = [];
  const seenSha = new Set<string>();
  const seenNames = new Set<string>();
  let duplicates = 0;
  let mimeMismatches = 0;

  raws.forEach((raw, index) => {
    const decoded = decodeBase64Strict(raw.dataBase64);
    if (!decoded.ok) {
      failures.push({ index, reason: decoded.error });
      return;
    }
    const bytes = decoded.bytes;
    if (bytes.length === 0) {
      failures.push({ index, reason: 'zero-byte resource' });
      return;
    }
    if (bytes.length > opts.maxResourceBytes) {
      failures.push({
        index,
        reason: `resource ${bytes.length}B exceeds maxResourceBytes ${opts.maxResourceBytes}B`,
      });
      return;
    }

    const sha256Hex = createHash('sha256').update(bytes).digest('hex');
    const md5Hex = createHash('md5').update(bytes).digest('hex');
    if (seenSha.has(sha256Hex)) {
      duplicates += 1;
      return; // §15.7.6：同笔记内去重，引用走同一 enex-resource URI
    }
    seenSha.add(sha256Hex);

    const declaredMime = raw.mime.trim().toLowerCase() || 'application/octet-stream';
    const sniffed = sniffMime(bytes);
    const actualMime = sniffed ?? declaredMime;
    const mimeMismatch = sniffed !== null && sniffed !== declaredMime;
    if (mimeMismatch) mimeMismatches += 1;
    const kind = assetKindOf(actualMime);
    const ext = extForMime(actualMime);

    // 命名链（§15.7.4）
    let fileName: string;
    const cleanedOriginal =
      raw.fileName !== undefined && raw.fileName.trim().length > 0
        ? sanitizeFilename(raw.fileName, { maxLength: 120 })
        : '';
    if (cleanedOriginal.length > 0) {
      fileName = cleanedOriginal;
      if (!fileName.toLowerCase().endsWith(`.${ext}`)) {
        // 原扩展名与实际类型不符：以实际类型为准（保留主名，替换扩展名）
        const stem = fileName.replace(/\.[^.]+$/, '');
        fileName = `${stem}.${ext}`;
      }
    } else {
      fileName = `${String(resources.length + 1).padStart(3, '0')}.${ext}`;
    }
    if (seenNames.has(fileName.toLowerCase())) {
      const stem = fileName.replace(/\.[^.]+$/, '');
      fileName = `${stem}-${sha256Hex.slice(0, 8)}.${ext}`;
    }
    seenNames.add(fileName.toLowerCase());

    resources.push({
      md5Hex,
      sha256Hex,
      actualMime,
      declaredMime,
      mimeMismatch,
      attachment: raw.attachment === 'true',
      fileName,
      asset: {
        externalId: md5Hex,
        originalUrl: enexResourceUri(md5Hex),
        mimeType: actualMime,
        byteSize: bytes.length,
        sha256: `sha256:${sha256Hex}`,
        kind,
        fileName,
        data: new Uint8Array(bytes),
      },
    });
  });

  return { resources, failures, duplicates, mimeMismatches };
}
