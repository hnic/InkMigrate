import { useState } from 'react';
import type { AppSettings } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  busy: boolean;
}

export function CleanupPage({ settings, update, rpcCall, addLog, busy }: Props) {
  const [maxItems, setMaxItems] = useState('');
  const [result, setResult] = useState<{ successCount: number; skipCount: number; failCount: number } | null>(null);
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

      const res = await rpcCall('cleanup.unfavorite', params) as {
        successCount: number; skipCount: number; failCount: number;
      };
      setResult(res);
      addLog('info', `清理完成：成功 ${res.successCount}, 跳过 ${res.skipCount}, 失败 ${res.failCount}`);
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
          已迁移到 Obsidian 的内容不会丢失，但头条上的收藏会被移除。
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>最多处理条目数（留空=全部已迁移）</label>
          <input
            type="number"
            value={maxItems}
            onChange={(e) => setMaxItems(e.target.value)}
            placeholder="例：10"
            style={{ width: '120px' }}
          />
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
                {busy ? '清理中...' : '确认取消收藏'}
              </button>
              <button onClick={() => setConfirming(false)} disabled={busy}>
                取消
              </button>
            </div>
          </div>
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
          </div>
        )}
      </div>
    </div>
  );
}
