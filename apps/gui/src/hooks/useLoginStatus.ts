import { useEffect, useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, AuthStatusResult } from '../lib/types.js';

interface Options {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
}

/**
 * 应用级登录态检测。`settings.loggedIn` 是全局唯一真相源。
 *
 * - stateDir 配置后/变化时自动检测一次（不再依赖必须打开 LoginPage）。
 * - 直接调用 Tauri `invoke` 而非 useSidecar 的 `rpcCall`，因此是静默的：
 *   不触发 busy/进度条，清理进行中检测登录态也不会让顶栏闪"处理中"。
 * - 检测失败不改写已有登录态（保留 localStorage 旧值），避免瞬时网络/锁
 *   阻塞导致卡片误判"未登录"。
 */
export function useLoginStatus({ settings, update }: Options) {
  /** 递增请求令牌：新检测使旧的在途结果作废，避免旧目录的结果覆盖新目录的登录态 */
  const reqIdRef = useRef(0);
  /** 始终指向最新 refresh；自动检测只依赖真正的触发输入（stateDir/source），
   *  不随 refresh 闭包身份变化（loggedIn 翻转等）而重复触发 */
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  /** Profile 路径展示（auth.status 顺带返回，供 LoginPage 复用，避免二次 RPC） */
  const [profilePath, setProfilePath] = useState('');

  const refresh = useCallback(async () => {
    if (!settings.stateDir) {
      setProfilePath('');
      return;
    }
    const myReq = ++reqIdRef.current;
    try {
      const result = await invoke('send_rpc', {
        method: 'auth.status',
        params: { source: settings.source, stateDir: settings.stateDir },
      }) as AuthStatusResult;
      if (myReq !== reqIdRef.current) return; // 已被更新的检测取代，丢弃过期结果
      setProfilePath(result.profileExists ? result.profilePath : '');
      // 只在结果与当前值不同时写，避免无谓渲染
      if (result.profileExists !== Boolean(settings.loggedIn)) {
        update({ loggedIn: result.profileExists });
      }
    } catch (err) {
      // 检测失败保留旧值，UI 保持静默，但留下诊断痕迹
      console.warn('[useLoginStatus] auth.status 检测失败:', err);
    }
  }, [settings.stateDir, settings.source, settings.loggedIn, update]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // stateDir/source 变化时自动检测一次；应用启动后若已有 stateDir 也在此触发
  useEffect(() => {
    void refreshRef.current();
    // 依赖变化或卸载时使在途结果失效，防止过期回写
    return () => { reqIdRef.current += 1; };
  }, [settings.stateDir, settings.source]);

  return { refresh, profilePath };
}
