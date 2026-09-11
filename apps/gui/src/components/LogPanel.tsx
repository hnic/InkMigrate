import { memo, useEffect, useRef, useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { LogEntry } from '../lib/types.js';
import { Terminal, ChevronUp, ChevronDown, Trash2, Copy, Check } from 'lucide-react';

const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: 'var(--text)',
  warn: 'var(--warning)',
  error: 'var(--error)',
};

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-panel)',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  overflow: 'hidden',
  height: '100%',
};

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: '12px',
  lineHeight: '1.65',
  padding: '8px 12px',
};

const TIMESTAMP_STYLE: CSSProperties = { color: 'var(--text-dim)', marginRight: '6px' };
const EMPTY_STYLE: CSSProperties = { color: 'var(--text-dim)', fontStyle: 'italic' };

const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
  return (
    <div style={{ color: LOG_COLORS[log.level] ?? 'var(--text)', wordBreak: 'break-all' }}>
      <span style={TIMESTAMP_STYLE}>
        {new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
      </span>
      {log.message}
    </div>
  );
});

interface LogPanelProps {
  logs: LogEntry[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClear?: () => void;
}

export function LogPanel({ logs, collapsed, onToggleCollapse, onClear }: LogPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [copied, setCopied] = useState(false);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const filteredLogs = useMemo(() => {
    if (filter === 'all') return logs;
    return logs.filter((log) => log.level === filter);
  }, [logs, filter]);

  useEffect(() => {
    const el = containerRef.current;
    if (el && wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs]);

  const handleCopy = async () => {
    if (logs.length === 0) return;
    const text = logs
      .map(
        (l) =>
          `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('复制日志失败:', err);
    }
  };

  const latestLog = logs[logs.length - 1];

  // 折叠模式下只渲染紧凑条
  if (collapsed) {
    return (
      <div
        onClick={onToggleCollapse}
        style={{
          height: '36px',
          background: 'var(--bg-panel)',
          borderRadius: '6px',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          gap: '10px',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '12px',
        }}
        title="点击展开日志控制台"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-dim)' }}>
          <Terminal size={14} />
          <span>控制台</span>
          <span className="badge badge-neutral" style={{ fontSize: '10px', padding: '0 5px' }}>
            {logs.length}
          </span>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: latestLog ? LOG_COLORS[latestLog.level] : 'var(--text-dim)', opacity: 0.9 }}>
          {latestLog ? (
            <>
              <span style={TIMESTAMP_STYLE}>
                {new Date(latestLog.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              {latestLog.message}
            </>
          ) : (
            '就绪'
          )}
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse();
          }}
          className="btn-ghost btn-sm"
          style={{ padding: '4px' }}
        >
          <ChevronUp size={15} />
        </button>
      </div>
    );
  }

  return (
    <div style={ROOT_STYLE}>
      {/* 顶部工具栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(0,0,0,0.15)',
        fontSize: '12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
          <Terminal size={15} />
          <span>控制台日志</span>
          <span className="badge badge-neutral" style={{ fontSize: '10px' }}>
            {logs.length}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* 级别过滤 */}
          <div style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg)' }}>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={filter === 'all' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
              style={{ borderRadius: 0, padding: '2px 8px', fontSize: '11px' }}
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => setFilter('error')}
              className={filter === 'error' ? 'btn-danger btn-sm' : 'btn-ghost btn-sm'}
              style={{ borderRadius: 0, padding: '2px 8px', fontSize: '11px' }}
            >
              错误
            </button>
            <button
              type="button"
              onClick={() => setFilter('warn')}
              className={filter === 'warn' ? 'btn-secondary btn-sm' : 'btn-ghost btn-sm'}
              style={{ borderRadius: 0, padding: '2px 8px', fontSize: '11px', color: filter === 'warn' ? 'var(--warning)' : undefined }}
            >
              警告
            </button>
          </div>

          {/* 复制 */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={logs.length === 0}
            className="btn-ghost btn-sm"
            title="复制全部日志"
            style={{ padding: '4px 6px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
          >
            {copied ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>

          {/* 清空 */}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              disabled={logs.length === 0}
              className="btn-ghost btn-sm"
              title="清空当前日志面板"
              style={{ padding: '4px 6px' }}
            >
              <Trash2 size={13} />
            </button>
          )}

          {/* 折叠 */}
          <button
            type="button"
            onClick={onToggleCollapse}
            className="btn-ghost btn-sm"
            title="折叠日志"
            style={{ padding: '4px' }}
          >
            <ChevronDown size={15} />
          </button>
        </div>
      </div>

      {/* 滚动内容区 */}
      <div ref={containerRef} onScroll={handleScroll} style={SCROLL_STYLE}>
        {filteredLogs.length === 0 ? (
          <span style={EMPTY_STYLE}>
            {logs.length === 0 ? '等待操作...' : '无匹配该级别的日志'}
          </span>
        ) : (
          filteredLogs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  );
}
