import { memo, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { LogEntry } from '../lib/types.js';

/** level → 颜色：按 level 联合类型建表（模块级常量，避免每次渲染重建），
 *  新增 level 时编译期即可发现遗漏。 */
const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: 'var(--text)',
  warn: 'var(--warning)',
  error: 'var(--error)',
};

// 静态样式提升到模块级（同 LOG_COLORS）：日志追加会触发整面板重渲染
const ROOT_STYLE: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-panel)',
  borderRadius: '8px',
  padding: '12px',
  minHeight: '0',
};
const HEADER_STYLE: CSSProperties = { fontWeight: 600, marginBottom: '8px', fontSize: '13px' };
const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  fontFamily: 'ui-monospace, "SF Mono", monospace',
  fontSize: '12px',
  lineHeight: '1.7',
};
const TIMESTAMP_STYLE: CSSProperties = { color: 'var(--text-dim)' };
const EMPTY_STYLE: CSSProperties = { color: 'var(--text-dim)' };

/** 单条日志行。条目不可变且 id 稳定，memo 后仅新增行重渲染/重格式化时间戳。 */
const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
  return (
    <div style={{ color: LOG_COLORS[log.level] ?? 'var(--text)' }}>
      <span style={TIMESTAMP_STYLE}>
        {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}{' '}
      </span>
      {log.message}
    </div>
  );
});

export function LogPanel({ logs }: { logs: LogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 记录「用户上一次滚动后」是否位于底部（即新内容插入前的状态）：
  // 若在 effect 里事后测量，一次追加超过 40px 的内容（多条日志/换行消息）
  // 会被误判为用户已上翻，自动跟随悄悄失效
  const wasAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = containerRef.current;
    // 直接设置容器 scrollTop，不用 scrollIntoView（会连带滚动整页）
    if (el && wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div style={ROOT_STYLE}>
      <div style={HEADER_STYLE}>日志</div>
      <div ref={containerRef} onScroll={handleScroll} style={SCROLL_STYLE}>
        {logs.length === 0 ? (
          <span style={EMPTY_STYLE}>等待操作...</span>
        ) : (
          logs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}
