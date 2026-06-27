import { useState } from 'react';
import type { AppSettings } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  busy: boolean;
  /** 当前运行的 phase，用于判断按钮文字（是否本页任务在跑）。disabled 仍用 busy。 */
  activePhase: string | null;
  /** 终止当前正在运行的长任务。 */
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
      };
      if (maxItems) params.maxItems = parseInt(maxItems, 10);
      if (intervalMs) params.intervalMs = parseInt(intervalMs, 10);

      const res = await rpcCall('cleanup.unfavorite', params) as {
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
      <h2 style={{ fontSize: '18px' }}>取消收藏（清理源端）</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir']}
        message="⚠️ 请先填写工作区目录"
      />

      <div style={{
        padding: '16px',
        background: 'var(--bg-panel)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        <div style={{
          padding: '10px 12px',
          background: 'rgba(231, 76, 60, 0.15)',
          borderRadius: '6px',
          border: '1px solid rgba(231, 76, 60, 0.3)',
          fontSize: '13px',
        }}>
          ⚠️ 此操作会逐条打开文章详情页并取消收藏。<br/>
          已迁移到 Obsidian 的内容不会丢失，但头条上的收藏会被移除。<br/>
          为防触发风控，默认每次处理 200 条、条目间隔约 2 秒；可分多次运行（已成功项自动跳过）。
        </div>

        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>单次处理条目数（默认 200，防风控）</label>
            <input
              type="number"
              value={maxItems}
              onChange={(e) => setMaxItems(e.target.value)}
              placeholder="200"
              style={{ width: '120px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>条目间隔毫秒（默认 2000，±40% 抖动）</label>
            <input
              type="number"
              value={intervalMs}
              onChange={(e) => setIntervalMs(e.target.value)}
              placeholder="2000"
              style={{ width: '120px' }}
            />
          </div>
        </div>

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={busy || !settings.stateDir}
          >
            开始取消收藏
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>
              确认要取消收藏吗？此操作不可撤销。
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={handleCleanup} disabled={busy} className="btn-danger">
                {cleaning ? '清理中...' : busy ? '等待其他任务完成...' : '确认取消收藏'}
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy}>
                取消
              </button>
            </div>
          </div>
        )}

        {/* 清理进行中显示终止按钮 */}
        {cleaning && (
          <button onClick={() => void cancel()} className="btn-danger">
            终止清理
          </button>
        )}

        {error && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(231, 76, 60, 0.15)',
            borderRadius: '6px',
            border: '1px solid rgba(231, 76, 60, 0.3)',
            color: 'var(--error)',
            fontSize: '13px',
          }}>
            ❌ {error}
          </div>
        )}

        {result && (
          <div style={{ display: 'flex', gap: '20px', padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>成功取消</div>
              <div style={{ fontWeight: 600, color: 'var(--success)' }}>{result.successCount}</div>
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>跳过（未收藏）</div>
              <div style={{ fontWeight: 600, color: 'var(--text-dim)' }}>{result.skipCount}</div>
            </div>
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>失败</div>
              <div style={{ fontWeight: 600, color: 'var(--error)' }}>{result.failCount}</div>
            </div>
            {result.unknownCount !== undefined && result.unknownCount > 0 && (
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>未知（状态判定失败）</div>
                <div style={{ fontWeight: 600, color: 'var(--text-dim)' }}>{result.unknownCount}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
