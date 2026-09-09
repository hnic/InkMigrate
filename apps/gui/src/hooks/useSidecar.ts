import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProgressEvent, LogEntry, HealthDegradedNotification } from '../lib/types.js';

/** 日志面板保留的最大条数（超出后丢最旧的）。 */
const MAX_LOG_ENTRIES = 200;

/** Engine 日志合法 level 白名单，异常值回退 info。 */
const LOG_LEVELS = ['info', 'warn', 'error'] as const;

/** method → phase 映射。让发起任务时自动声明对应的 phase，
 * 各页面据此判断"我自己是否在运行"，无需依赖进度事件的异步到达。 */
const METHOD_PHASE: Record<string, string> = {
  'scan.start': 'scanning',
  'migrate.start': 'migrating',
  'migrate.resume': 'migrating',
  'cleanup.unfavorite': 'cleanup',
  'auth.login': 'login',
};

/** 日志条目自增 id：LogPanel 用作稳定 key（数组截断后索引 key 会漂移）。 */
let nextLogId = 1;

export function useSidecar() {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  /** 当前正在运行的 RPC 对应的 phase（由发起者声明），用于让每个页面判断
   * "是不是我自己发起的任务在跑"，避免 A 任务跑时 B 页面误显示"运行中"。 */
  const [activePhase, setActivePhase] = useState<string | null>(null);
  /** 引擎健康降级状态。uncaughtException 后由 engine 推送，仅重启应用可解除。 */
  const [healthDegraded, setHealthDegraded] = useState<HealthDegradedNotification | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  /** I30: 进度条 2 秒清除定时器，避免与新任务进度条竞态。 */
  const progressClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 长任务在途标记：同步重入守卫，防止并发长任务互相覆盖 busy/activePhase。 */
  const longTaskInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // I9: listen() 在权限缺失或 event 系统异常时会 reject，补 .catch 避免未处理 rejection。
    const on = <T,>(event: string, label: string, handler: (payload: T) => void) => {
      listen<T>(event, (e) => handler(e.payload))
        .then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); })
        .catch((err) => console.error(`${label} listen 失败`, err));
    };

    on<ProgressEvent>('sidecar://progress', 'progress', setProgress);

    on<{ level: string; message: string }>('sidecar://log', 'log', (p) => {
      setLogs((prev) => [
        ...prev.slice(-(MAX_LOG_ENTRIES - 1)),
        {
          id: nextLogId++,
          level: LOG_LEVELS.includes(p.level as LogEntry['level'])
            ? (p.level as LogEntry['level'])
            : 'info',
          message: p.message,
          timestamp: Date.now(),
        },
      ]);
    });

    on<{ message: string }>('sidecar://crashed', 'crashed', (p) => {
      setLogs((prev) => [
        ...prev.slice(-(MAX_LOG_ENTRIES - 1)),
        { id: nextLogId++, level: 'error', message: `⚠️ ${p.message}`, timestamp: Date.now() },
      ]);
      setBusy(false);
      // R4-M8: 重置 activePhase（原只重置 busy，页面级 activePhase 检查卡在错误状态）
      setActivePhase(null);
    });

    on<HealthDegradedNotification>('sidecar://health', 'health', (p) => {
      setHealthDegraded(p);
      setLogs((prev) => [
        ...prev.slice(-(MAX_LOG_ENTRIES - 1)),
        {
          id: nextLogId++,
          level: 'error',
          message: `⚠️ 引擎状态降级：${p.message}`,
          timestamp: Date.now(),
        },
      ]);
      // 降级意味着当前长任务结果不可信，重置 busy/activePhase（同 crashed 语义）
      setBusy(false);
      setActivePhase(null);
    });

    return () => {
      cancelled = true;
      // 清掉残留的进度清除定时器，避免卸载后仍 setProgress
      if (progressClearTimer.current !== null) {
        clearTimeout(progressClearTimer.current);
        progressClearTimer.current = null;
      }
      for (const fn of unlistenRefs.current) {
        try { fn(); } catch { /* already unlistened */ }
      }
      unlistenRefs.current = [];
    };
  }, []);

  const rpcCall = useCallback(async (method: string, params: Record<string, unknown>) => {
    // R11: 只有长任务（在 METHOD_PHASE 中有声明的）才翻转 busy/progress/activePhase。
    // 读操作（status.query / migrate.resumable 等）不应影响全局 busy，否则查询报告时
    // 顶栏误显示「处理中」且清空进度条。
    const isLongTask = method in METHOD_PHASE;
    if (isLongTask && healthDegraded !== null) {
      throw new Error('引擎状态已降级，请重启应用后再操作');
    }
    // 注意：rpcCall 依赖 healthDegraded（见下方 useCallback deps）。降级翻转时
    // rpcCall 重建以拦截新长任务；勿把 deps 改回 []，否则冻结会因闭包过期失效。
    if (isLongTask) {
      // activePhase 是异步翻转的，按钮禁用前的快速双击会重复启动任务；
      // 用同步 ref 守卫拒绝并发长任务（两个长任务并跑会互相覆盖 busy/phase）。
      if (longTaskInFlight.current) {
        throw new Error('已有长任务在运行，请等待完成或先终止');
      }
      longTaskInFlight.current = true;
      setBusy(true);
      setProgress(null);
      setActivePhase(METHOD_PHASE[method]);
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
    } catch (err) {
      // 失败路径立即清除进度，避免最后一次部分进度（如 45%）永久残留
      if (isLongTask) {
        setProgress(null);
      }
      throw err;
    } finally {
      if (isLongTask) {
        longTaskInFlight.current = false;
        setBusy(false);
        setActivePhase(null);
      }
    }
  }, [healthDegraded]);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [
      ...prev.slice(-(MAX_LOG_ENTRIES - 1)),
      { id: nextLogId++, level, message, timestamp: Date.now() },
    ]);
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

  return { rpcCall, progress, logs, busy, activePhase, healthDegraded, addLog, cancel };
}
