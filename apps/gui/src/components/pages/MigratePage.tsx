import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, ResumableJob, MigrateResult } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';
import { normalizeFavoritesUrl, isSendableFavoritesUrl } from '../../lib/favorites-url.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 当前运行的 phase：按钮禁用改由 activePhase 判定（避免登录收尾的 busy 锁住迁移）。 */
  activePhase: string | null;
  /** 终止当前正在运行的长任务。 */
  cancel: () => Promise<void>;
}

export function MigratePage({ settings, update, rpcCall, addLog, activePhase, cancel }: Props) {
  const migrating = activePhase === 'migrating';
  const [maxItems, setMaxItems] = useState('');
  const [interval, setIntervalMs] = useState('1500');
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableJob>({ job: null });

  /** 静默查询可续跑 Job：直接走 Tauri invoke，不翻 busy，避免误禁用"开始迁移"。
   *  模式同 useLoginStatus——查询类 RPC 不应进入任务 busy 生命周期。 */
  const refreshResumable = useCallback(async () => {
    if (!settings.stateDir || !settings.source) {
      setResumable({ job: null });
      return;
    }
    try {
      const res = (await invoke('send_rpc', {
        method: 'migrate.resumable',
        params: { source: settings.source, stateDir: settings.stateDir },
      })) as ResumableJob;
      setResumable(res);
    } catch {
      // 查询失败不报错打扰用户，静默置空
      setResumable({ job: null });
    }
  }, [settings.stateDir, settings.source]);

  // 进入页面 / 关键配置变化时自动查询可续跑 Job
  useEffect(() => {
    void refreshResumable();
  }, [refreshResumable]);

  /** 迁移参数共用的 favoritesUrl 规范化（与登录/扫描页同口径）。 */
  function resolveFavoritesUrlParam(): { value?: string; error?: string } {
    const favoritesUrl = normalizeFavoritesUrl(settings.favoritesUrl);
    if (favoritesUrl === '') return {};
    if (!isSendableFavoritesUrl(favoritesUrl)) {
      return { error: `收藏列表 URL 无法识别（需 http(s) 链接）：「${favoritesUrl}」，请在「设置」页修正` };
    }
    if (favoritesUrl !== settings.favoritesUrl) {
      update({ favoritesUrl });
    }
    return { value: favoritesUrl };
  }

  async function handleMigrate() {
    setResult(null);
    setError(null);
    const fav = resolveFavoritesUrlParam();
    if (fav.error !== undefined) {
      setError(fav.error);
      addLog('error', `迁移失败：${fav.error}`);
      return;
    }
    try {
      const params: Record<string, unknown> = {
        source: settings.source,
        target: settings.target,
        stateDir: settings.stateDir,
        vaultPath: settings.vaultPath,
      };
      if (fav.value !== undefined) params.favoritesUrl = fav.value;
      if (maxItems) params.maxItems = parseInt(maxItems, 10);
      if (interval) params.intervalMs = parseInt(interval, 10);
      // §10.2 配置驱动的来源分派（Evernote 文件源）
      if (settings.configPath) params.configPath = settings.configPath;

      const res = await rpcCall('migrate.start', params) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `迁移完成：${res.scanCount} 条`);
      // 迁移结束（无论完成/中断/失败）后刷新可续跑状态
      void refreshResumable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `迁移失败：${msg}`);
    }
  }

  async function handleResume() {
    if (!resumable.job) return;
    setResult(null);
    setError(null);
    const fav = resolveFavoritesUrlParam();
    if (fav.error !== undefined) {
      setError(fav.error);
      addLog('error', `续跑失败：${fav.error}`);
      return;
    }
    try {
      const params: Record<string, unknown> = {
        job: resumable.job,
        stateDir: settings.stateDir,
        vaultPath: settings.vaultPath,
      };
      if (fav.value !== undefined) params.favoritesUrl = fav.value;
      if (maxItems) params.maxItems = parseInt(maxItems, 10);
      if (settings.configPath) params.configPath = settings.configPath;

      const res = await rpcCall('migrate.resume', params) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `续跑完成：${res.scanCount} 条`);
      void refreshResumable();
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
                disabled={migrating || !settings.stateDir || !settings.vaultPath || !settings.favoritesUrl || !settings.loggedIn}
              >
                {migrating ? '迁移中...' : '开始迁移'}
              </button>
          <button onClick={() => void cancel()} disabled={!migrating} className="btn-danger">
            终止
          </button>
        </div>

        {/* 断点续跑：自动查询可续跑 Job，无需手填 ID */}
        <div style={{
          marginTop: '8px',
          paddingTop: '12px',
          borderTop: '1px solid var(--border)',
        }}>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>
            断点续跑（中断后继续，自动跳过已完成的条目）
          </label>
          {resumable.job ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                {resumable.status === 'paused' ? '已暂停' : '上次中断'}
                {resumable.total !== undefined && resumable.verified !== undefined && (
                  <>，已完成 {resumable.verified}/{resumable.total}</>
                )}
              </div>
              <button
                onClick={handleResume}
                disabled={migrating || !settings.stateDir || !settings.vaultPath}
              >
                {migrating ? '续跑中...' : '继续迁移'}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
              没有可续跑的 Job（首次迁移或上次已正常完成）
            </div>
          )}
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
