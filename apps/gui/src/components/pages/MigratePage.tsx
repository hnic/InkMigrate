import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, ResumableJob, MigrateResult, PageId } from '../../lib/types.js';
import { ConfigPrompt, type ConfigField } from '../ConfigPrompt.js';
import { normalizeFavoritesUrl, isSendableFavoritesUrl } from '../../lib/favorites-url.js';
import { Play, Square, RotateCw, ExternalLink, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 当前运行的 phase：按钮禁用改由 activePhase 判定（避免登录收尾的 busy 锁住迁移）。 */
  activePhase: string | null;
  /** 终止当前正在运行的长任务。 */
  cancel: () => Promise<void>;
  /** 跳转页面回调。 */
  onNavigate?: (page: PageId) => void;
}

export function MigratePage({ settings, update, rpcCall, addLog, activePhase, cancel, onNavigate }: Props) {
  const migrating = activePhase === 'migrating';
  const isEvernote = settings.sourceAdapter === 'evernote';

  const [maxItems, setMaxItems] = useState('');
  const [interval, setIntervalMs] = useState('1500');
  const [result, setResult] = useState<MigrateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableJob>({ job: null });

  /** 静默查询可续跑 Job：直接走 Tauri invoke，不翻 busy，避免误禁用"开始迁移"。 */
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
      setResumable({ job: null });
    }
  }, [settings.stateDir, settings.source]);

  useEffect(() => {
    void refreshResumable();
  }, [refreshResumable]);

  /** 迁移参数共用的 favoritesUrl 规范化（仅头条源需要）。 */
  function resolveFavoritesUrlParam(): { value?: string; error?: string } {
    if (isEvernote) return {};
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
      if (settings.configPath) params.configPath = settings.configPath;

      const res = (await rpcCall('migrate.start', params)) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `迁移完成：${res.scanCount} 条`);
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

      const res = (await rpcCall('migrate.resume', params)) as MigrateResult;
      setResult(res);
      addLog(res.reconciliationOk ? 'info' : 'warn', `续跑完成：${res.scanCount} 条`);
      void refreshResumable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `续跑失败：${msg}`);
    }
  }

  // 解耦校验逻辑：Evernote 无需登录态与收藏 URL
  const canStart = isEvernote
    ? Boolean(settings.stateDir && settings.vaultPath && settings.configPath)
    : Boolean(settings.stateDir && settings.vaultPath && settings.favoritesUrl && settings.loggedIn);

  const requiredFields: ConfigField[] = isEvernote
    ? ['stateDir', 'vaultPath', 'configPath']
    : ['stateDir', 'vaultPath', 'favoritesUrl'];

  const statusLabels: Record<string, string> = {
    completed: '完成',
    failed: '失败',
    interrupted: '已中断',
    paused: '已暂停（限流）',
  };

  const handleOpenVault = async () => {
    if (!settings.vaultPath) return;
    try {
      await invoke('open_in_folder', { path: settings.vaultPath });
    } catch (err) {
      console.warn('打开 Vault 失败:', err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>迁移到 Obsidian</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={requiredFields}
        message="⚠️ 请先补齐以下必要配置才能开始迁移"
      />

      <div style={{ padding: '18px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '16px', border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>限制条目数（留空=全量，测试用）</label>
            <input
              type="number"
              value={maxItems}
              onChange={(e) => setMaxItems(e.target.value)}
              placeholder="例：10"
              style={{ width: '140px' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>请求间隔（毫秒，默认 1500 防风控）</label>
            <input
              type="number"
              value={interval}
              onChange={(e) => setIntervalMs(e.target.value)}
              style={{ width: '140px' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-dim)' }}>
          <span>目标 Vault：{settings.vaultPath || '（未设置）'}</span>
          {Boolean(settings.vaultPath) && (
            <button
              type="button"
              onClick={handleOpenVault}
              className="btn-ghost btn-sm"
              title="在系统文件管理器中打开 Vault 目录"
              style={{ padding: '2px 6px', fontSize: '12px' }}
            >
              <ExternalLink size={13} />
              <span>打开目录</span>
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={handleMigrate}
            disabled={migrating || !canStart}
            className="btn-primary"
            style={{ minWidth: '120px' }}
          >
            <Play size={15} />
            <span>{migrating ? '迁移中...' : '开始迁移'}</span>
          </button>
          <button onClick={() => void cancel()} disabled={!migrating} className="btn-danger">
            <Square size={14} />
            <span>终止</span>
          </button>
        </div>

        {/* 断点续跑：自动查询可续跑 Job，无需手填 ID */}
        <div style={{
          marginTop: '6px',
          paddingTop: '14px',
          borderTop: '1px solid var(--border)',
        }}>
          <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
            断点续跑（中断后继续，自动跳过已完成条目）
          </label>
          {resumable.job ? (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
                {resumable.status === 'paused' ? '⚠️ 已暂停（限流）' : '⚠️ 上次迁移意外中断'}
                {resumable.total !== undefined && resumable.verified !== undefined && (
                  <> · 已安全落盘 {resumable.verified}/{resumable.total} 条</>
                )}
              </div>
              <button
                onClick={handleResume}
                disabled={migrating || !settings.stateDir || !settings.vaultPath}
                className="btn-secondary"
              >
                <RotateCw size={14} />
                <span>继续迁移</span>
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
              没有可续跑的 Job（首次迁移或上次已正常完成）
            </div>
          )}
        </div>

        {/* 头条源未登录提示（Evernote 模式绝不显示） */}
        {!isEvernote && settings.stateDir && settings.vaultPath && settings.favoritesUrl && !settings.loggedIn && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(245, 158, 11, 0.12)',
            borderRadius: '6px',
            border: '1px solid rgba(245, 158, 11, 0.25)',
            fontSize: '13px',
            color: 'var(--warning)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}>
            <AlertTriangle size={16} />
            <span>今日头条来源需先在「登录」页面完成扫码登录。</span>
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
          <div style={{ padding: '14px', background: 'var(--bg-hover)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>状态</div>
                <div style={{ fontWeight: 600, color: result.status === 'completed' ? 'var(--success)' : 'var(--warning)' }}>
                  {statusLabels[result.status] ?? result.status}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>条目数</div>
                <div style={{ fontWeight: 600 }}>{result.scanCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>对账结果</div>
                <div style={{ fontWeight: 600, color: result.reconciliationOk ? 'var(--success)' : 'var(--error)' }}>
                  {result.reconciliationOk ? '✅ 通过' : '❌ 失败'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Job ID</div>
                <div style={{ fontFamily: 'monospace', fontSize: '12px' }}>{result.jobId}</div>
              </div>

              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('report')}
                  className="btn-secondary btn-sm"
                  style={{ marginLeft: 'auto' }}
                >
                  <span>查看迁移报告</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>

            {!result.reconciliationOk && result.reconciliationReason && (
              <div style={{ fontSize: '12px', color: 'var(--warning)' }}>
                对账告警：{result.reconciliationReason}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
