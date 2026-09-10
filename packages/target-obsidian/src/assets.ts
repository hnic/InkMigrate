import {
  constants,
  existsSync,
  readFileSync,
  openSync,
  closeSync,
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
  // 诊断一致性：空内容在 atomicWriteRaw 里只会得到无上下文的 'content is empty'，
  // 批量迁移时无法归因到具体附件；此处提前拦截并附上 relativePath（与
  // verifyAsset 的失败诊断格式对齐）。
  if (i.bytes.length === 0) {
    throw new Error(`asset content is empty: "${i.relativePath}"`);
  }
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
  // C6/H4: 校验后用同一文件描述符读取（open 一次、read 走 fd）——路径在两次
  // 系统调用之间被替换时读到的仍是校验过的那个 inode。fd-pinning 只保护
  // open 之后的读取，check→open 窗口由 O_NOFOLLOW 关闭（POSIX）：终组件在
  // assertSymlinkSafe 之后、open 之前被换成指向 Vault 外的符号链接时，
  // openSync 解引用会拿到外部 fd，而 O_NOFOLLOW 使 open 直接 ELOOP 失败。
  // 工具写入的附件经 rename 落盘，终组件必为普通文件，ELOOP 即按不安全路径
  // 失败处理。Windows 无此标志（undefined），维持 core H4 声明的残留窗口。
  // fs 错误统一附上 relativePath + cause（保留原始 errno 与堆栈），与本函数
  // 其它失败路径的诊断格式一致。
  let bytes: Buffer;
  try {
    const flags =
      constants.O_RDONLY |
      (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);
    const fd = openSync(abs, flags);
    try {
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw new Error(
      `asset unreadable during verification "${i.relativePath}": ${(e as Error).message}`,
      { cause: e },
    );
  }
  // §13.7 附件必须非空：atomicWriteRaw 拒绝空内容，此处防御的是写入后磁盘被
  // 外部清空/截断的情况。先判空再比对哈希：合法附件内容非空（哈希必不等于
  // 空字节 SHA-256），空文件先撞零字节检查得到精确诊断，而不是误导性的
  // "hash mismatch ... got e3b0c442..."。
  if (bytes.length === 0) {
    throw new Error(`asset is zero bytes after write: "${i.relativePath}"`);
  }
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

/** §13.7 从 MIME 推导扩展名（用于无扩展名的来源 URL）。
 * 未知类型确定性地回退 'bin'：扩展名是磁盘命名契约（改动映射会改变既有
 * Vault 内的附件路径，破坏重跑幂等），不在运行时告警或自动扩展；需要支持
 * 新类型时在此显式补条目并评估对已迁移路径的影响。 */
export function deriveMimeExtension(mime: string): string {
  if (!mime) return 'bin';
  const base = mime.split(';')[0]!.trim().toLowerCase();
  return MIME_EXT[base] ?? 'bin';
}
