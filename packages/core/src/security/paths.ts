import { resolve, relative, isAbsolute } from 'node:path';
import { realpathSync, lstatSync, readlinkSync } from 'node:fs';

/**
 * §13.2 / §13.4 路径防护。所有目标路径都必须在解引用符号链接后再次确认位于 Vault 内。
 */

/**
 * 路径逃逸错误。机器可判别（`code === 'E_VAULT_ESCAPE'`），供调用方与
 * `realpathSync` 的 ENOENT（`NodeJS.ErrnoException`）精确区分后分别 catch，
 * 不必依赖错误消息文本。
 */
export class VaultPathEscapeError extends Error {
  readonly code = 'E_VAULT_ESCAPE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathEscapeError';
  }
}

/** 检测字符串中是否包含 `..` 路径段（正斜杠或反斜杠）。 */
export function rejectsTraversal(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return norm.split('/').some((seg) => seg === '..');
}

/**
 * 在 `root` 下解析 `target`。若解析结果在 `root` 之外，抛出 `escape` 错误。
 * 不解析符号链接；若需要符号链接防护，调用方应在 `resolveWithin` 后再调用
 * `assertSymlinkSafe`。
 */
export function resolveWithin(root: string, target: string): string {
  const resolved = resolve(root, target);
  const rel = relative(root, resolved);
  // 首段精确比较 '..'：startsWith('..') 会把合法的「.. 开头文件名」（如
  // ..draft.md，POSIX/Windows 上只要不恰好是 .. 即合法）误判为逃逸。
  const firstSeg = rel.split(/[\\/]/, 1)[0];
  if (firstSeg === '..' || isAbsolute(rel)) {
    throw new VaultPathEscapeError(`path "${target}" escapes root "${root}"`);
  }
  return resolved;
}

/** `child` 是否位于 `parent` 内（非符号链接解析）。 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  // 同 resolveWithin：按首段精确比较，避免误判 .. 开头的合法文件名
  const firstSeg = rel.split(/[\\/]/, 1)[0];
  return !!rel && firstSeg !== '..' && !isAbsolute(rel);
}

/**
 * §13.2 解引用符号链接后再次确认 `target` 仍在 `root` 内。
 * 调用方应捕获 ENOENT（链接或目标不存在）。
 *
 * target 等于 root（文件就位于 Vault 根目录）视为安全——isPathInside 严格区分
 * "在内部"与"相等"，但符号链接逃逸校验的语义是"不逃出 root"，相等即不逃出。
 *
 * R14/H-2/R4-M6（大小写不敏感 FS）：realpathSync 返回 OS 权威存储路径（已规范化
 * 大小写）。在 APFS（默认不敏感）/NTFS 上，配置路径 MyVault 和磁盘 myvault 经
 * realpathSync 后都返回磁盘真实形式（如 /Users/x/myvault），直接比较即可，无需
 * toLowerCase。
 *
 * R4-M6: 原 H-2 用 toLowerCase 全局比较，在 Linux（大小写敏感 FS）上造成安全漏洞——
 * 不同目录 /vault/Bar 和 /vault/bar lowercase 相同 → isPathInside 误判 inside
 * → symlink 逃逸被放行。回退到 realpath 直接比较（realpath 已规范化大小写）。
 */
export function assertSymlinkSafe(root: string, target: string): void {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !isPathInside(realTarget, realRoot)) {
    throw new VaultPathEscapeError(
      `resolved path "${realTarget}" escapes root "${realRoot}" via symlink`,
    );
  }
}

/**
 * §13.2 写入前的统一符号链接防护：对【父目录】解引用确认位于 `root` 内。
 *
 * 目标文件可能尚不存在（realpathSync 会 ENOENT），符号链接攻击面在父目录链，
 * 故校验父目录即可。这是 atomic-write / writeShard / 后续新增写入点应共用的
 * 一致语义，避免每处各自处理 ENOENT 与目录创建的细节差异。
 *
 * 调用方应在 mkdirSync(parentDir, { recursive: true }) 之后、writeFileSync 之前调用。
 *
 * H4（TOCTOU 残留窗口，诚实声明）：本函数的 realpathSync 校验与后续 write/rename
 * 是两次独立的系统调用，之间存在理论上的 TOCTOU 窗口——若攻击者在 realpathSync 之后、
 * write/rename 之前把父目录链中的某级替换为指向 Vault 外的符号链接，写入会逃逸。
 * 完整闭合需 fd-based 写入（逐组件 open with O_NOFOLLOW，持有 fd 后再 write），
 * 这在纯 Node.js 层面难以完全实现（需 native addon）。
 *
 * 当前威胁模型：InkMigrate 是本地单用户工具，攻击者需在同一机器具备写 Vault 目录
 * 的能力并能赢得毫秒级竞争窗口——实际风险极低。本函数提供的是「纵深防御 + 检测
 * 已存在的逃逸符号链接」，而非对实时攻击的完全保证。atomicWriteRaw 的 tmp 文件
 * 用 randomBytes(6) 随机命名，使攻击者无法预置 tmp 路径的符号链接，进一步收窄窗口。
 */
export function assertWriteDirSafe(root: string, targetAbsPath: string): void {
  const parentDir = resolve(targetAbsPath, '..');
  assertSymlinkSafe(root, parentDir);
  // 终组件若已存在且为符号链接：按路径直接 writeFileSync 会跟随它逃逸到 Vault 外
  //（rename 型写入不受影响——rename 替换目录项而非跟随，但本函数是共享防护，
  // 需同时覆盖两种写入方式）。目标尚不存在时无逃逸面。
  let isLink = false;
  try {
    isLink = lstatSync(targetAbsPath).isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (isLink) {
    try {
      // 非悬空链接：realpath 解完整链接链后复核仍在 root 内
      assertSymlinkSafe(root, targetAbsPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // 悬空链接（realpath ENOENT）：写入会在链接目标处创建文件，词法校验目标位置
      const linkTarget = resolve(targetAbsPath, '..', readlinkSync(targetAbsPath));
      if (linkTarget !== resolve(root) && !isPathInside(linkTarget, root)) {
        throw new VaultPathEscapeError(
          `dangling symlink "${targetAbsPath}" resolves outside root "${root}"`,
        );
      }
    }
  }
}
