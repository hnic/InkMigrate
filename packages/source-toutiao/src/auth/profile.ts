import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rejectsTraversal, assertSymlinkSafe } from '@inkmigrate/core';

/**
 * §12.2 工具专用持久化 Profile 路径管理。
 *
 * Profile 位于 `<workspace.stateDir>/profiles/<sourceInstanceId>`。
 * 该 Profile 与用户日常 Chrome Profile 隔离；§12.2 禁止使用用户日常 Profile。
 */
export function profilePath(stateDir: string, sourceInstanceId: string): string {
  // 拒绝空串与 "."：二者 resolve 后都退化为 profiles 根目录本身——
  // 不同 id 会静默映射到同一目录，profileExists('') 恒真，清理类调用方
  // 拿到该路径可能误删全部 profile
  if (sourceInstanceId === '' || sourceInstanceId === '.') {
    throw new Error(
      `sourceInstanceId must be a non-empty flat id, got: "${sourceInstanceId}"`,
    );
  }
  if (rejectsTraversal(sourceInstanceId)) {
    throw new Error(
      `sourceInstanceId contains traversal segments: "${sourceInstanceId}"`,
    );
  }
  // 进一步拒绝任何绝对路径或包含路径分隔符的 sourceId
  if (sourceInstanceId.includes('/') || sourceInstanceId.includes('\\')) {
    throw new Error(
      `sourceInstanceId must be a flat id, got: "${sourceInstanceId}"`,
    );
  }
  return resolve(join(stateDir, 'profiles', sourceInstanceId));
}

export function profileExists(stateDir: string, sourceInstanceId: string): boolean {
  return existsSync(profilePath(stateDir, sourceInstanceId));
}

export function ensureProfileDir(stateDir: string, sourceInstanceId: string): string {
  const p = profilePath(stateDir, sourceInstanceId);
  mkdirSync(p, { recursive: true });
  // 防御预置符号链接：mkdir recursive 对"已是符号链接的目录"静默成功，而该目录
  // 会被浏览器当作 user-data 目录写入（含会话 Cookie）。确认解引用后的真实路径
  // 仍在 profiles 根目录内（§13.2 同款纵深防御）
  assertSymlinkSafe(resolve(stateDir, 'profiles'), p);
  return p;
}
