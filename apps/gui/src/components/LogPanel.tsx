import { useEffect, useRef } from 'react';
import type { LogEntry } from '../lib/types.js';

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const colors: Record<string, string> = {
    info: 'var(--text)',
    warn: 'var(--warning)',
    error: 'var(--error)',
  };

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderRadius: '8px',
      padding: '12px',
      minHeight: '0',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '13px' }}>日志</div>
      <div style={{
        flex: 1,
        overflowY: 'auto',
        fontFamily: 'ui-monospace, "SF Mono", monospace',
        fontSize: '12px',
        lineHeight: '1.7',
      }}>
        {logs.length === 0 ? (
          <span style={{ color: 'var(--text-dim)' }}>等待操作...</span>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={{ color: colors[log.level] ?? 'var(--text)' }}>
              <span style={{ color: 'var(--text-dim)' }}>
                {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
              </span>
              {log.message}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
