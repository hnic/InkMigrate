import { useEffect, useRef } from 'react';
import type { LogEntry } from '../lib/types.js';

/** level → 颜色（模块级常量，避免每次渲染重建）。 */
const LOG_COLORS: Record<string, string> = {
  info: 'var(--text)',
  warn: 'var(--warning)',
  error: 'var(--error)',
};

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // 仅当用户本就停留在底部时跟随滚动（向上翻看旧日志时不被打断）；
    // 直接设置容器 scrollTop，不用 scrollIntoView（会连带滚动整页）
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

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
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          fontFamily: 'ui-monospace, "SF Mono", monospace',
          fontSize: '12px',
          lineHeight: '1.7',
        }}
      >
        {logs.length === 0 ? (
          <span style={{ color: 'var(--text-dim)' }}>等待操作...</span>
        ) : (
          logs.map((log) => (
            <div key={log.id} style={{ color: LOG_COLORS[log.level] ?? 'var(--text)' }}>
              <span style={{ color: 'var(--text-dim)' }}>
                {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
              </span>
              {log.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
