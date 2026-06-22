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
 */
export function assertSymlinkSafe(root: string, target: string): void {
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!isPathInside(realTarget, realRoot)) {
    throw new Error(
      `resolved path "${realTarget}" escapes root "${realRoot}" via symlink`,
    );
  }
}
