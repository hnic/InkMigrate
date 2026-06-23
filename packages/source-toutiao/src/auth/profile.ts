import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rejectsTraversal } from '@inkmigrate/core';

/**
 * §12.2 工具专用持久化 Profile 路径管理。
 *
 * Profile 位于 `<workspace.stateDir>/profiles/<sourceInstanceId>`。
 * 该 Profile 与用户日常 Chrome Profile 隔离；§12.2 禁止使用用户日常 Profile。
 */
export function profilePath(stateDir: string, sourceInstanceId: string): string {
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
  return p;
}
