import { useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../lib/types.js';

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
  // 防止并发重复检测
  const inFlight = useRef(false);
  // mount 后只自动检测一次的标记（stateDir 变化时仍可再触发）
  const firstRun = useRef(true);

  const refresh = useCallback(async () => {
    if (!settings.stateDir || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await invoke('send_rpc', {
        method: 'auth.status',
        params: { source: settings.source, stateDir: settings.stateDir },
      }) as { profileExists: boolean; profilePath: string };
      // 只在结果与当前值不同时写，避免无谓渲染
      if (result.profileExists !== Boolean(settings.loggedIn)) {
        update({ loggedIn: result.profileExists });
      }
    } catch {
      // 检测失败保留旧值，静默
    } finally {
      inFlight.current = false;
    }
  }, [settings.stateDir, settings.source, settings.loggedIn, update]);

  // stateDir 变化时自动检测；应用启动后若已有 stateDir 也检测一次
  useEffect(() => {
    void refresh();
    firstRun.current = false;
  }, [refresh]);

  return { refresh };
}
