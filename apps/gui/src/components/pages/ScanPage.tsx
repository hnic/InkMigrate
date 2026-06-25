import { useState } from 'react';
import type { AppSettings } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  busy: boolean;
}

export function ScanPage({ settings, rpcCall, addLog, busy }: Props) {
  const [result, setResult] = useState<{ uniqueItems: number; terminationReason: string } | null>(null);

  async function handleScan() {
    setResult(null);
    try {
      const res = await rpcCall('scan.start', {
        source: settings.source,
        stateDir: settings.stateDir,
        favoritesUrl: settings.favoritesUrl,
      }) as { uniqueItems: number; terminationReason: string };
      setResult(res);
      addLog('info', `扫描完成：${res.uniqueItems} 条（${res.terminationReason}）`);
    } catch (e) {
      addLog('error', `扫描失败：${(e as Error).message}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>扫描收藏</h2>

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          将打开浏览器扫描你的头条收藏列表。扫描数据会保存到数据库，供后续迁移使用。
        </div>

        <button onClick={handleScan} disabled={busy || !settings.stateDir || !settings.favoritesUrl}>
          {busy ? '扫描中...' : '开始扫描'}
        </button>

        {result && (
          <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--success)' }}>
              {result.uniqueItems}
            </div>
            <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
              个唯一条目 · {result.terminationReason}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
