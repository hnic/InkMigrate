import {
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  resolveWithin,
  assertSymlinkSafe,
  assertWriteDirSafe,
  writtenFileHash,
} from '@inkmigrate/core';

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

/**
 * §13.7 写入附件字节。附件是 content-addressed，不做用户修改保护（与笔记不同）。
 *
 * C6: 符号链接逃逸防护。原实现仅 resolveWithin（词法 `..` 检查，不解析 symlink），
 * 若 Vault 内附件目录链中存在指向外部的 symlink，writeFileSync 会解引用并把任意字节
 * 写到 Vault 外（如 ~/.ssh/authorized_keys）。与笔记侧 atomicWrite/writeShard 一致，
 * 这里在 mkdir 之后、write 之前调用 assertWriteDirSafe 校验父目录链真实路径在 Vault 内。
 */
export function writeAsset(i: WriteAssetInput): WriteAssetResult {
  const abs = resolveWithin(i.vaultPath, i.relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  assertWriteDirSafe(i.vaultPath, abs);
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

/**
 * §13.7 写入后必须验证存在、非零字节、哈希。
 *
 * C6: 读取前同样做 assertSymlinkSafe，避免把指向 Vault 外的 symlink 目标内容读进进程。
 */
export function verifyAsset(i: VerifyAssetInput): void {
  const abs = resolveWithin(i.vaultPath, i.relativePath);
  if (!existsSync(abs)) {
    throw new Error(`asset missing after write: "${i.relativePath}"`);
  }
  assertSymlinkSafe(i.vaultPath, abs);
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
