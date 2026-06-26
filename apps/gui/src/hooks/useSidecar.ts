import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ProgressEvent, LogEntry } from '../lib/types.js';

export function useSidecar() {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let cancelled = false;
    listen<ProgressEvent>('sidecar://progress', (e) => {
      setProgress(e.payload);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); });

    listen<{ level: string; message: string }>('sidecar://log', (e) => {
      setLogs((prev) => [
        ...prev.slice(-199),
        {
          level: (e.payload.level as 'info' | 'warn' | 'error') ?? 'info',
          message: e.payload.message,
          timestamp: Date.now(),
        },
      ]);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); });

    listen<{ message: string }>('sidecar://crashed', (e) => {
      setLogs((prev) => [
        ...prev.slice(-199),
        { level: 'error', message: `⚠️ ${e.payload.message}`, timestamp: Date.now() },
      ]);
      setBusy(false);
    }).then((fn) => { if (cancelled) fn(); else unlistenRefs.current.push(fn); });

    return () => {
      cancelled = true;
      for (const fn of unlistenRefs.current) {
        try { fn(); } catch { /* already unlistened */ }
      }
      unlistenRefs.current = [];
    };
  }, []);

  const rpcCall = useCallback(async (method: string, params: Record<string, unknown>) => {
    setBusy(true);
    setProgress(null);
    try {
      const result = await invoke('send_rpc', { method, params });
      // 延迟 2 秒清除进度条，让用户看到 100% 完成状态
      setTimeout(() => setProgress(null), 2000);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [...prev.slice(-199), { level, message, timestamp: Date.now() }]);
  }, []);

  return { rpcCall, progress, logs, busy, addLog };
}
