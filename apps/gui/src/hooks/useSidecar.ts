import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProgressEvent, LogEntry } from '../lib/types.js';

export function useSidecar() {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** 当前正在运行的 RPC 对应的 phase（由发起者声明），用于让每个页面判断
   * "是不是我自己发起的任务在跑"，避免 A 任务跑时 B 页面误显示"运行中"。 */
  const [activePhase, setActivePhase] = useState<string | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  /** I30: 进度条 2 秒清除定时器，避免与新任务进度条竞态。 */
  const progressClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // I9: listen() 在权限缺失或 event 系统异常时会 reject，补 .catch 避免未处理 rejection。
    listen<ProgressEvent>('sidecar://progress', (e) => {
      setProgress(e.payload);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); })
      .catch((e) => console.error('progress listen 失败', e));

    listen<{ level: string; message: string }>('sidecar://log', (e) => {
      setLogs((prev) => [
        ...prev.slice(-199),
        {
          level: (e.payload.level as 'info' | 'warn' | 'error') ?? 'info',
          message: e.payload.message,
          timestamp: Date.now(),
        },
      ]);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); })
      .catch((e) => console.error('log listen 失败', e));

    listen<{ message: string }>('sidecar://crashed', (e) => {
      setLogs((prev) => [
        ...prev.slice(-199),
        { level: 'error', message: `⚠️ ${e.payload.message}`, timestamp: Date.now() },
      ]);
      setBusy(false);
      // R4-M8: 重置 activePhase（原只重置 busy，页面级 activePhase 检查卡在错误状态）
      setActivePhase(null);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); })
      .catch((e) => console.error('crashed listen 失败', e));

    return () => {
      cancelled = true;
      for (const fn of unlistenRefs.current) {
        try { fn(); } catch { /* already unlistened */ }
      }
      unlistenRefs.current = [];
    };
  }, []);

  /** method → phase 映射。让发起任务时自动声明对应的 phase，
   * 各页面据此判断"我自己是否在运行"，无需依赖进度事件的异步到达。 */
  const METHOD_PHASE: Record<string, string> = {
    'scan.start': 'scanning',
    'migrate.start': 'migrating',
    'migrate.resume': 'migrating',
    'cleanup.unfavorite': 'cleanup',
    'auth.login': 'login',
  };

  const rpcCall = useCallback(async (method: string, params: Record<string, unknown>) => {
    // R11: 只有长任务（在 METHOD_PHASE 中有声明的）才翻转 busy/progress/activePhase。
    // 读操作（status.query / migrate.resumable 等）不应影响全局 busy，否则查询报告时
    // 顶栏误显示「处理中」且清空进度条。
    const isLongTask = method in METHOD_PHASE;
    if (isLongTask) {
      setBusy(true);
      setProgress(null);
      setActivePhase(METHOD_PHASE[method] ?? null);
      // I30: 清掉上一轮残留的清进度定时器，避免它在 2 秒后清掉新任务的进度条。
      if (progressClearTimer.current !== null) {
        clearTimeout(progressClearTimer.current);
        progressClearTimer.current = null;
      }
    }
    try {
      const result = await invoke('send_rpc', { method, params });
      if (isLongTask) {
        // 延迟 2 秒清除进度条，让用户看到 100% 完成状态
        progressClearTimer.current = setTimeout(() => {
          setProgress(null);
          progressClearTimer.current = null;
        }, 2000);
      }
      return result;
    } finally {
      if (isLongTask) {
        setBusy(false);
        setActivePhase(null);
      }
    }
  }, []);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), { level, message, timestamp: Date.now() }]);
  }, []);

  /** 终止当前正在运行的长任务。静默调用（不经 rpcCall，不翻转 busy），
   *  否则会立即禁用终止按钮自身。调用 Tauri cancel_job command 转发给 sidecar。 */
  const cancel = useCallback(async () => {
    addLog('warn', '正在终止当前任务...');
    try {
      await invoke('cancel_job', {});
    } catch (e) {
      addLog('error', `终止失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [addLog]);

  return { rpcCall, progress, logs, busy, activePhase, addLog, cancel };
}
