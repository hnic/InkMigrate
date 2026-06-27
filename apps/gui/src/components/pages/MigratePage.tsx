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

interface MigrateResult {
  status: string;
  scanCount: number;
  reconciliationOk: boolean;
  reconciliationReason?: string;
  jobId: string;
}

export function MigratePage({ settings, update, rpcCall, addLog, busy, activePhase, cancel }: Props) {
  const migrating = activePhase === 'migrating';
  const [maxItems, setMaxItems] = useState('');
  const [interval, setIntervalMs] = useState('1500');
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumeJobId, setResumeJobId] = useState('');

  async function handleMigrate() {
    setResult(null);
    setError(null);
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

      const res = await rpcCall('migrate.start', params) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `迁移完成：${res.scanCount} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `迁移失败：${msg}`);
    }
  }

  async function handleResume() {
    setResult(null);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        job: resumeJobId,
        stateDir: settings.stateDir,
        vaultPath: settings.vaultPath,
      };
      if (settings.favoritesUrl) params.favoritesUrl = settings.favoritesUrl;
      if (maxItems) params.maxItems = parseInt(maxItems, 10);

      const res = await rpcCall('migrate.resume', params) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `续跑完成：${res.scanCount} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `续跑失败：${msg}`);
    }
  }

  const statusLabels: Record<string, string> = {
    completed: '完成',
    failed: '失败',
    interrupted: '已中断',
    paused: '已暂停（限流）',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>迁移到 Obsidian</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir', 'vaultPath']}
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

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleMigrate}
            disabled={busy || !settings.stateDir || !settings.vaultPath || !settings.favoritesUrl || !settings.loggedIn}
          >
            {migrating ? '迁移中...' : busy ? '等待其他任务完成...' : '开始迁移'}
          </button>
          <button onClick={() => void cancel()} disabled={!migrating} className="btn-danger">
            终止
          </button>
        </div>

        {/* 断点续跑 */}
        <div style={{
          marginTop: '8px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>
            断点续跑（中断后继续，自动跳过已完成的条目）
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={resumeJobId}
              onChange={(e) => setResumeJobId(e.target.value)}
              placeholder="中断的 Job ID（如 mig-1782417170231）"
              style={{ flex: 1, fontFamily: 'monospace', fontSize: '12px' }}
            />
            <button
              onClick={handleResume}
              disabled={busy || !resumeJobId || !settings.stateDir || !settings.vaultPath}
            >
              {migrating ? '续跑中...' : busy ? '等待...' : '继续迁移'}
            </button>
          </div>
        </div>

        {settings.stateDir && settings.vaultPath && settings.favoritesUrl && !settings.loggedIn && (
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
          <div style={{ padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>状态</div>
                <div style={{ fontWeight: 600, color: result.status === 'completed' ? 'var(--success)' : 'var(--warning)' }}>
                  {statusLabels[result.status] ?? result.status}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>条目数</div>
                <div style={{ fontWeight: 600 }}>{result.scanCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>对账</div>
                <div style={{ fontWeight: 600, color: result.reconciliationOk ? 'var(--success)' : 'var(--error)' }}>
                  {result.reconciliationOk ? '✅ 通过' : '❌ 失败'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>Job ID</div>
                <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>{result.jobId}</div>
              </div>
            </div>
            {!result.reconciliationOk && result.reconciliationReason && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--warning)' }}>
                {result.reconciliationReason}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
