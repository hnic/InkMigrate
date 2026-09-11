import type { CSSProperties, ReactNode } from 'react';
import type { ProgressEvent } from '../lib/types.js';
import { Search, Package, Trash2, Key, CheckCircle2, AlertTriangle, XCircle, SkipForward } from 'lucide-react';

const phaseIcons: Record<ProgressEvent['phase'], ReactNode> = {
  scanning: <Search size={16} />,
  migrating: <Package size={16} />,
  cleanup: <Trash2 size={16} />,
  login: <Key size={16} />,
};

const phaseLabels: Record<ProgressEvent['phase'], string> = {
  scanning: '扫描中',
  migrating: '迁移中',
  cleanup: '清理中',
  login: '登录中',
};

const stageLabels: Record<string, string> = {
  scanning: '扫描收藏列表',
  extracting: '提取并写入笔记',
  planning: '规划迁移',
  reporting: '生成报告',
};

const panelStyle: CSSProperties = {
  background: 'var(--bg-panel)',
  padding: '14px 16px',
  borderRadius: '8px',
  border: '1px solid var(--accent)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};

const phaseTextStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: '15px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const stageTextStyle: CSSProperties = {
  color: 'var(--text-dim)',
  marginLeft: '6px',
  fontWeight: 400,
  fontSize: '13px',
};

const countsTextStyle: CSSProperties = { color: 'var(--text-dim)', marginLeft: '8px', fontWeight: 400 };

const trackStyle: CSSProperties = {
  height: '8px',
  background: 'var(--bg-hover)',
  borderRadius: '4px',
  overflow: 'hidden',
  position: 'relative',
};

const currentItemStyle: CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: '12px',
  marginTop: '8px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const countsRowStyle: CSSProperties = {
  display: 'flex',
  gap: '16px',
  marginTop: '10px',
  fontSize: '12px',
  fontWeight: 600,
  flexWrap: 'wrap',
};

export function ProgressBar({ progress }: { progress: ProgressEvent | null }) {
  if (progress === null) return null;

  const rawPct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
  const pct = Math.min(100, Math.max(0, Math.floor(rawPct)));
  const isComplete = progress.total > 0 && progress.current >= progress.total;

  const phaseLabel = phaseLabels[progress.phase] ?? progress.phase;
  const stageLabel = progress.stage !== undefined ? (stageLabels[progress.stage] ?? progress.stage) : null;
  const icon = phaseIcons[progress.phase];

  return (
    <div style={panelStyle} aria-live="polite">
      {/* 第一行：阶段 + 百分比 */}
      <div style={headerRowStyle}>
        <span style={phaseTextStyle}>
          {icon}
          <span>{phaseLabel}</span>
          {stageLabel !== null && (
            <span style={stageTextStyle}>
              · {stageLabel}
            </span>
          )}
          {progress.total > 0 && (
            <span style={countsTextStyle}>
              {progress.current} / {progress.total}
            </span>
          )}
        </span>
        {progress.total > 0 && (
          <span style={{ fontSize: '18px', fontWeight: 800, color: isComplete ? 'var(--success)' : 'var(--accent)' }}>
            {pct}%
          </span>
        )}
      </div>

      {/* 进度条 */}
      {progress.total > 0 && (
        <div
          style={trackStyle}
          role="progressbar"
          aria-label={`${phaseLabel}进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: isComplete
                ? 'var(--success)'
                : 'linear-gradient(90deg, var(--accent), var(--accent-hover))',
              borderRadius: '4px',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
      )}

      {/* 当前条目 */}
      {progress.currentItem && (
        <div style={currentItemStyle} title={progress.currentItem}>
          正在处理: {progress.currentItem}
        </div>
      )}

      {/* 状态计数 */}
      {progress.counts && (
        <div style={countsRowStyle}>
          {progress.counts.verified !== undefined && (
            <span style={{ color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <CheckCircle2 size={13} />
              <span>已落盘 {progress.counts.verified}</span>
            </span>
          )}
          {progress.counts.degraded !== undefined && progress.counts.degraded > 0 && (
            <span style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <AlertTriangle size={13} />
              <span>降级 {progress.counts.degraded}</span>
            </span>
          )}
          {progress.counts.conflict !== undefined && progress.counts.conflict > 0 && (
            <span style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <AlertTriangle size={13} />
              <span>冲突 {progress.counts.conflict}</span>
            </span>
          )}
          {progress.counts.failed !== undefined && progress.counts.failed > 0 && (
            <span style={{ color: 'var(--error)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <XCircle size={13} />
              <span>失败 {progress.counts.failed}</span>
            </span>
          )}
          {progress.counts.skipped !== undefined && progress.counts.skipped > 0 && (
            <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <SkipForward size={13} />
              <span>跳过 {progress.counts.skipped}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
