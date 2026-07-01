import {
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import {
  resolveWithin,
  assertSymlinkSafe,
  writtenFileHash,
} from '@inkmigrate/core';
import { atomicWriteRaw } from './atomic-write.js';

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
 * 写到 Vault 外（如 ~/.ssh/authorized_keys）。atomicWriteRaw 内部在写入前后做
 * assertSymlinkSafe 校验真实路径在 Vault 内。
 *
 * H3: 原直接 writeFileSync 非原子——进程被杀留下半截损坏附件，且重跑保护可能把它
 * 当「用户改过 → 跳过覆写」。现复用 atomicWriteRaw（temp + rename），与笔记/索引侧
 * （I17 修复）一致，消除半写风险。
 */
export function writeAsset(i: WriteAssetInput): WriteAssetResult {
  const abs = resolveWithin(i.vaultPath, i.relativePath);
  const hash = atomicWriteRaw(abs, i.bytes, i.vaultPath);
  return {
    relativePath: i.relativePath,
    writtenFileHash: hash,
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
