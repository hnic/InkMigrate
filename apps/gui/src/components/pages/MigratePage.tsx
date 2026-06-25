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

export function MigratePage({ settings, update, rpcCall, addLog, busy }: Props) {
  const [maxItems, setMaxItems] = useState('');
  const [interval, setIntervalMs] = useState('1500');
  const [result, setResult] = useState<{ status: string; scanCount: number; jobId: string } | null>(null);

  async function handleMigrate() {
    setResult(null);
    try {
      const params: Record<string, unknown> = {
        source: settings.source,
        target: settings.target,
        stateDir: settings.stateDir,
        vaultPath: settings.vaultPath,
      };
      if (settings.favoritesUrl) params.favoritesUrl = settings.favoritesUrl;
      if (maxItems) params.maxItems = parseInt(maxItems, 10);
      if (interval) params.intervalMs = parseInt(interval, 10);

      const res = await rpcCall('migrate.start', params) as {
        status: string; scanCount: number; reconciliationOk: boolean; jobId: string;
      };
      setResult(res);
      addLog(
        res.reconciliationOk ? 'info' : 'warn',
        `迁移完成：status=${res.status}, count=${res.scanCount}, reconcile=${res.reconciliationOk}`,
      );
    } catch (e) {
      addLog('error', `迁移失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>迁移到 Obsidian</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir', 'vaultPath', 'favoritesUrl']}
        message="⚠️ 请先填写以下配置才能迁移"
      />

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>限制条目数（留空=全量，测试用）</label>
          <input
            type="number"
            value={maxItems}
            onChange={(e) => setMaxItems(e.target.value)}
            placeholder="例：10"
            style={{ width: '120px' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>请求间隔（毫秒，默认 1500 防风控）</label>
          <input
            type="number"
            value={interval}
            onChange={(e) => setIntervalMs(e.target.value)}
            style={{ width: '120px' }}
          />
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
          Vault: {settings.vaultPath || '（未设置）'}
        </div>

        <button
          onClick={handleMigrate}
          disabled={busy || !settings.stateDir || !settings.vaultPath || !settings.favoritesUrl}
        >
          {busy ? '迁移中...' : '开始迁移'}
        </button>

        {result && (
          <div style={{ padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div style={{ display: 'flex', gap: '20px' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>状态</div>
                <div style={{ fontWeight: 600, color: result.status === 'completed' ? 'var(--success)' : 'var(--warning)' }}>
                  {result.status}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>条目数</div>
                <div style={{ fontWeight: 600 }}>{result.scanCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Job ID</div>
                <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>{result.jobId}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
