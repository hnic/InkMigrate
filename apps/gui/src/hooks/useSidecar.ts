import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProgressEvent, LogEntry } from '../lib/types.js';

/**
 * Sidecar 通信 hook：封装 RPC 调用、进度事件和日志事件。
 *
 * - rpcCall(): 发送 JSON-RPC 请求到 Rust 后端，返回 result
 * - progress: 当前进度事件（null 表示无活跃任务）
 * - logs: 累积日志（最多 200 条）
 * - busy: 是否有 RPC 调用正在进行
 */
export function useSidecar() {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let unP: UnlistenFn | undefined;
    let unL: UnlistenFn | undefined;

    listen<ProgressEvent>('sidecar://progress', (e) => {
      setProgress(e.payload);
    }).then((fn) => {
      unP = fn;
      unlistenRefs.current.push(fn);
    });

    listen<{ level: string; message: string }>('sidecar://log', (e) => {
      setLogs((prev) => [
        ...prev.slice(-199),
        {
          level: (e.payload.level as 'info' | 'warn' | 'error') ?? 'info',
          message: e.payload.message,
          timestamp: Date.now(),
        },
      ]);
    }).then((fn) => {
      unL = fn;
      unlistenRefs.current.push(fn);
    });

    return () => {
      unP?.();
      unL?.();
    };
  }, []);

  const rpcCall = useCallback(async (method: string, params: Record<string, unknown>) => {
    setBusy(true);
    setProgress(null);
    try {
      const result = await invoke('send_rpc', { method, params });
      return result;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), { level, message, timestamp: Date.now() }]);
  }, []);

  const clearProgress = useCallback(() => setProgress(null), []);

  return { rpcCall, progress, logs, busy, addLog, clearProgress };
}
