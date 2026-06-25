import type { ProgressEvent } from '../lib/types.js';

export function ProgressBar({ progress }: { progress: ProgressEvent | null }) {
  if (progress === null) return null;

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const phaseLabels: Record<string, string> = {
    scanning: '扫描中',
    migrating: '迁移中',
    cleanup: '清理中',
    login: '登录中',
  };
  const phaseLabel = phaseLabels[progress.phase] ?? progress.phase;

  return (
    <div style={{ background: 'var(--bg-panel)', padding: '12px 16px', borderRadius: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
        <span style={{ fontWeight: 600 }}>{phaseLabel}</span>
        {progress.total > 0 && (
          <span style={{ color: 'var(--text-dim)' }}>
            {progress.current} / {progress.total} ({pct}%)
          </span>
        )}
      </div>
      {progress.total > 0 && (
        <div style={{ height: '6px', background: 'var(--bg-hover)', borderRadius: '3px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: 'var(--success)',
              transition: 'width 0.3s',
            }}
          />
        </div>
      )}
      {progress.currentItem && (
        <div style={{ color: 'var(--text-dim)', fontSize: '12px', marginTop: '6px' }}>
          {progress.currentItem}
        </div>
      )}
      {progress.counts && (
        <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '12px' }}>
          {progress.counts.verified !== undefined && (
            <span style={{ color: 'var(--success)' }}>✅ {progress.counts.verified}</span>
          )}
          {progress.counts.degraded !== undefined && (
            <span style={{ color: 'var(--warning)' }}>⚠️ {progress.counts.degraded}</span>
          )}
          {progress.counts.failed !== undefined && (
            <span style={{ color: 'var(--error)' }}>❌ {progress.counts.failed}</span>
          )}
          {progress.counts.skipped !== undefined && (
            <span style={{ color: 'var(--text-dim)' }}>⏭️ {progress.counts.skipped}</span>
          )}
        </div>
      )}
    </div>
  );
}
