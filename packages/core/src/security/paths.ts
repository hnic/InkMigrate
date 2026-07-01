import { resolve, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * §13.2 / §13.4 路径防护。所有目标路径都必须在解引用符号链接后再次确认位于 Vault 内。
 */

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
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${target}" escapes root "${root}"`);
  }
  return resolved;
}

/** `child` 是否位于 `parent` 内（非符号链接解析）。 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * §13.2 解引用符号链接后再次确认 `target` 仍在 `root` 内。
 * 调用方应捕获 ENOENT（链接或目标不存在）。
 *
 * target 等于 root（文件就位于 Vault 根目录）视为安全——isPathInside 严格区分
 * "在内部"与"相等"，但符号链接逃逸校验的语义是"不逃出 root"，相等即不逃出。
 */
export function assertSymlinkSafe(root: string, target: string): void {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (realTarget !== realRoot && !isPathInside(realTarget, realRoot)) {
    throw new Error(
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
}
