import { useState } from 'react';
import type { AppSettings } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';
import { Trash2, AlertTriangle, Square, CheckCircle2, XCircle } from 'lucide-react';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  busy: boolean;
  activePhase: string | null;
  cancel: () => Promise<void>;
}

export function CleanupPage({ settings, update, rpcCall, addLog, busy, activePhase, cancel }: Props) {
  const cleaning = activePhase === 'cleanup';
  const [maxItems, setMaxItems] = useState('200');
  const [intervalMs, setIntervalMs] = useState('2000');
  const [result, setResult] = useState<{ successCount: number; skipCount: number; failCount: number; unknownCount?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function handleCleanup() {
    setConfirming(false);
    setResult(null);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        source: settings.source,
        stateDir: settings.stateDir,
        confirmed: true,
      };
      if (maxItems) params.maxItems = parseInt(maxItems, 10);
      if (intervalMs) params.intervalMs = parseInt(intervalMs, 10);

      const res = (await rpcCall('cleanup.unfavorite', params)) as {
        successCount: number; skipCount: number; failCount: number; unknownCount?: number;
      };
      setResult(res);
      addLog('info', `清理完成：成功 ${res.successCount}, 跳过 ${res.skipCount}, 失败 ${res.failCount}${res.unknownCount ? `, 未知 ${res.unknownCount}` : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `清理失败：${msg}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Trash2 size={20} />
        <span>取消收藏（清理源端）</span>
      </h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir']}
        message="⚠️ 请先填写工作区目录"
      />

      <div style={{
        padding: '18px',
        background: 'var(--bg-panel)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        border: '1px solid var(--border)',
      }}>
        <div style={{
          padding: '12px 14px',
          background: 'rgba(239, 68, 68, 0.08)',
          borderRadius: '6px',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          fontSize: '13px',
          color: 'var(--text)',
          lineHeight: '1.6',
          display: 'flex',
          gap: '10px',
        }}>
          <AlertTriangle size={20} color="var(--error)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <strong>注意事项：</strong>此操作会逐条打开文章详情页并点击取消收藏。<br />
            已迁移到 Obsidian 的本地笔记不会丢失，但头条云端收藏会被移除。<br />
            为防风控封禁，默认单次处理 200 条，每条模拟阅读后再取消。若遇到风控挑战将暂停 15 分钟重试。
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
              单次处理条目数（默认 200）
            </label>
            <input
              type="number"
              value={maxItems}
              onChange={(e) => setMaxItems(e.target.value)}
              placeholder="200"
              style={{ width: '140px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
              条目间隔毫秒（默认 2000，带抖动）
            </label>
            <input
              type="number"
              value={intervalMs}
              onChange={(e) => setIntervalMs(e.target.value)}
              placeholder="2000"
              style={{ width: '140px' }}
            />
          </div>
        </div>

        {!confirming ? (
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => setConfirming(true)}
              disabled={busy || !settings.stateDir}
              className="btn-danger"
              style={{ minWidth: '130px' }}
            >
              <Trash2 size={15} />
              <span>开始取消收藏</span>
            </button>
            {cleaning && (
              <button onClick={() => void cancel()} className="btn-secondary">
                <Square size={14} />
                <span>终止清理</span>
              </button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--error)' }}>
              ⚠️ 确认要开始取消收藏吗？此操作不可逆！
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleCleanup} disabled={busy} className="btn-danger">
                {cleaning ? '清理中...' : busy ? '等待其他任务完成...' : '确认执行'}
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy} className="btn-secondary">
                取消返回
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            borderRadius: '6px',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--error)',
            fontSize: '13px',
          }}>
            ❌ {error}
          </div>
        )}

        {result && (
          <div style={{ display: 'flex', gap: '24px', padding: '14px', background: 'var(--bg-hover)', borderRadius: '6px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>成功取消</div>
              <div style={{ fontWeight: 600, color: 'var(--success)', fontSize: '16px' }}>{result.successCount}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>跳过（非文章或已无收藏）</div>
              <div style={{ fontWeight: 600, color: 'var(--text-dim)', fontSize: '16px' }}>{result.skipCount}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>失败</div>
              <div style={{ fontWeight: 600, color: 'var(--error)', fontSize: '16px' }}>{result.failCount}</div>
            </div>
            {result.unknownCount !== undefined && result.unknownCount > 0 && (
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>状态未知</div>
                <div style={{ fontWeight: 600, color: 'var(--warning)', fontSize: '16px' }}>{result.unknownCount}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
