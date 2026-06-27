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

export function ScanPage({ settings, update, rpcCall, addLog, busy, activePhase, cancel }: Props) {
  const scanning = activePhase === 'scanning';
  const [result, setResult] = useState<{ uniqueItems: number; terminationReason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reasonLabels: Record<string, string> = {
    no_new_items_after_5_cycles: '连续 5 轮无新内容',
    no_load_more: '没有更多内容',
    cancelled: '已终止',
  };

  async function handleScan() {
    setResult(null);
    setError(null);
    try {
      const res = await rpcCall('scan.start', {
        source: settings.source,
        stateDir: settings.stateDir,
        favoritesUrl: settings.favoritesUrl,
      }) as { uniqueItems: number; terminationReason: string };
      setResult(res);
      addLog('info', `扫描完成：${res.uniqueItems} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `扫描失败：${msg}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>扫描收藏</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir']}
        message="⚠️ 请先填写工作区目录，并确保已登录"
      />

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          将打开浏览器扫描你的头条收藏列表。扫描数据会保存到数据库，供后续迁移使用。
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleScan} disabled={busy || !settings.stateDir || !settings.favoritesUrl || !settings.loggedIn}>
            {scanning ? '扫描中...' : busy ? '等待其他任务完成...' : '开始扫描'}
          </button>
          <button onClick={() => void cancel()} disabled={!scanning} className="btn-danger">
            终止
          </button>
        </div>

        {settings.stateDir && settings.favoritesUrl && !settings.loggedIn && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(243, 156, 18, 0.15)',
            borderRadius: '6px',
            border: '1px solid rgba(243, 156, 18, 0.3)',
            fontSize: '13px',
          }}>
            ⚠️ 请先在「登录」页面完成登录
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
          <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--success)' }}>
              {result.uniqueItems}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
              个唯一条目 · {reasonLabels[result.terminationReason] ?? result.terminationReason}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
