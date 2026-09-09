import type { CSSProperties } from 'react';
import type { ProgressEvent } from '../lib/types.js';

const phaseLabels: Record<string, string> = {
  scanning: '🔍 扫描中',
  migrating: '📦 迁移中',
  cleanup: '🗑️ 清理中',
  login: '🔑 登录中',
};
const stageLabels: Record<string, string> = {
  scanning: '扫描收藏列表',
  extracting: '提取并写入笔记',
  planning: '规划迁移',
  reporting: '生成报告',
};

// 静态样式提升到模块级：本组件每个进度 tick 都会重渲染，避免重复构建对象
const panelStyle: CSSProperties = {
  background: 'var(--bg-panel)',
  padding: '14px 16px',
  borderRadius: '8px',
  border: '1px solid var(--accent)',
  boxShadow: '0 0 12px rgba(15, 52, 96, 0.3)',
};
const headerRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: '8px',
};
const phaseTextStyle: CSSProperties = { fontWeight: 700, fontSize: '15px' };
const stageTextStyle: CSSProperties = {
  color: 'var(--text-dim)',
  marginLeft: '6px',
  fontWeight: 400,
  fontSize: '13px',
};
const countsTextStyle: CSSProperties = { color: 'var(--text-dim)', marginLeft: '8px', fontWeight: 400 };
const trackStyle: CSSProperties = {
  height: '10px',
  background: 'var(--bg-hover)',
  borderRadius: '5px',
  overflow: 'hidden',
  position: 'relative',
};
const currentItemStyle: CSSProperties = {
  color: 'var(--text-dim)',
  fontSize: '12px',
  marginTop: '6px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const countsRowStyle: CSSProperties = {
  display: 'flex',
  gap: '16px',
  marginTop: '8px',
  fontSize: '13px',
  fontWeight: 600,
};

export function ProgressBar({ progress }: { progress: ProgressEvent | null }) {
  if (progress === null) return null;

  // 钳制到 [0,100] 并向下取整：防止 current>total 时撑爆宽度，
  // 也避免 99.6% 这类未完成任务因四舍五入提前显示 100%
  const rawPct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
  const pct = Math.min(100, Math.max(0, Math.floor(rawPct)));

  const phaseLabel = phaseLabels[progress.phase] ?? progress.phase;
  const stageLabel = progress.stage !== undefined ? (stageLabels[progress.stage] ?? progress.stage) : null;

  return (
    <div style={panelStyle}>
      {/* 第一行：阶段 + 百分比 */}
      <div style={headerRowStyle}>
        <span style={phaseTextStyle}>
          {phaseLabel}
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
          <span style={{ fontSize: '20px', fontWeight: 800, color: pct === 100 ? 'var(--success)' : 'var(--accent-hover)' }}>
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
              background: pct === 100
                ? 'var(--success)'
                : 'linear-gradient(90deg, var(--accent), var(--accent-hover))',
              borderRadius: '5px',
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      )}

      {/* 当前条目 */}
      {progress.currentItem && (
        <div style={currentItemStyle}>
          {progress.currentItem}
        </div>
      )}

      {/* 状态计数 */}
      {progress.counts && (
        <div style={countsRowStyle}>
          {progress.counts.verified !== undefined && (
            <span style={{ color: 'var(--success)' }}>✅ {progress.counts.verified}</span>
          )}
          {progress.counts.degraded !== undefined && progress.counts.degraded > 0 && (
            <span style={{ color: 'var(--warning)' }}>⚠️ {progress.counts.degraded}</span>
          )}
          {progress.counts.conflict !== undefined && progress.counts.conflict > 0 && (
            <span style={{ color: 'var(--warning)' }}>⚠️ 冲突 {progress.counts.conflict}</span>
          )}
          {progress.counts.failed !== undefined && (
            <span style={{ color: 'var(--error)' }}>❌ {progress.counts.failed}</span>
          )}
          {progress.counts.skipped !== undefined && progress.counts.skipped > 0 && (
            <span style={{ color: 'var(--text-dim)' }}>⏭️ {progress.counts.skipped}</span>
          )}
        </div>
      )}
    </div>
  );
}
