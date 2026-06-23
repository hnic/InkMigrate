import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { resolveWithin, writtenFileHash } from '@inkmigrate/core';

export interface WriteAssetInput {
  vaultPath: string;
  relativePath: string;
  bytes: Buffer;
}

export interface WriteAssetResult {
  relativePath: string;
  writtenFileHash: string;
  byteSize: number;
}

/** §13.7 写入附件字节。附件是 content-addressed，不做用户修改保护（与笔记不同）。 */
export function writeAsset(i: WriteAssetInput): WriteAssetResult {
  const abs = resolveWithin(i.vaultPath, i.relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, i.bytes);
  return {
    relativePath: i.relativePath,
    writtenFileHash: writtenFileHash(i.bytes),
    byteSize: i.bytes.length,
  };
}

export interface VerifyAssetInput {
  vaultPath: string;
  relativePath: string;
  expectedSha256: string;
}

/** §13.7 写入后必须验证存在、非零字节、哈希。 */
export function verifyAsset(i: VerifyAssetInput): void {
  const abs = resolveWithin(i.vaultPath, i.relativePath);
  if (!existsSync(abs)) {
    throw new Error(`asset missing after write: "${i.relativePath}"`);
  }
  const stat = statSync(abs);
  if (stat.size === 0) {
    throw new Error(`asset is zero bytes after write: "${i.relativePath}"`);
  }
  const bytes = readFileSync(abs);
  const actual = writtenFileHash(bytes);
  if (actual !== i.expectedSha256) {
    throw new Error(
      `asset hash mismatch for "${i.relativePath}": expected ${i.expectedSha256}, got ${actual}`,
    );
  }
}

const MIME_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** §13.7 从 MIME 推导扩展名（用于无扩展名的来源 URL）。 */
export function deriveMimeExtension(mime: string): string {
  if (!mime) return 'bin';
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return MIME_EXT[base] ?? 'bin';
}
