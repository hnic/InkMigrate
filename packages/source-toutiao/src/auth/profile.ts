import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rejectsTraversal, assertSymlinkSafe } from '@inkmigrate/core';

/**
 * profiles 根目录（<workspace.stateDir>/profiles）。profilePath 与
 * ensureProfileDir 共用同一构造：'profiles' 段若改名/可配置化，两处各自拼接
 * 会静默漂移，同时破坏包含关系与符号链接校验。
 */
function profilesRoot(stateDir: string): string {
  return resolve(stateDir, 'profiles');
}

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
  return resolve(join(profilesRoot(stateDir), sourceInstanceId));
}

export function profileExists(stateDir: string, sourceInstanceId: string): boolean {
  // 不用 existsSync：它把 EACCES/EPERM 等"不可访问"也折叠成 false——目录真实
  // 存在但无读权限时，调用方（如 wiring 的 Profile 复用判定）会把它当"不存在"
  // 引导用户重新登录。仅 ENOENT 表示不存在，其余错误上抛暴露真实问题。
  try {
    lstatSync(profilePath(stateDir, sourceInstanceId));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

export function ensureProfileDir(stateDir: string, sourceInstanceId: string): string {
  const p = profilePath(stateDir, sourceInstanceId);
  try {
    mkdirSync(p, { recursive: true });
  } catch (e) {
    // 预置悬空符号链接：mkdir recursive 对链接占位路径抛裸 ENOENT（实测），
    // 属攻击指示性条件，不能以无关形态漏出；其余失败也带路径上下文重抛，
    // 裸 errno（EINVAL/EACCES 等）无法定位是哪个目录
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `profile path "${p}" resolves through a dangling symlink; refusing to use it`,
        { cause: e },
      );
    }
    throw new Error(
      `failed to create profile dir "${p}": ${(e as Error).message}`,
      { cause: e },
    );
  }
  // 防御预置符号链接：mkdir recursive 对"已是符号链接的目录"静默成功，而该目录
  // 会被浏览器当作 user-data 目录写入（含会话 Cookie）。确认解引用后的真实路径
  // 仍在 profiles 根目录内（§13.2 同款纵深防御）
  try {
    assertSymlinkSafe(profilesRoot(stateDir), p);
  } catch (e) {
    // mkdir 与校验之间路径被替换为悬空符号链接（realpath ENOENT）：core 契约
    // 要求调用方捕获 ENOENT，这里转成明确语义；逃逸类错误原样上抛
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `profile path "${p}" resolves through a dangling symlink; refusing to use it`,
        { cause: e },
      );
    }
    throw e;
  }
  return p;
}
