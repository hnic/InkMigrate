import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings, StatusQueryResult } from '../../lib/types.js';
import { BarChart3, Search, FolderOpen, ExternalLink, History } from 'lucide-react';

interface Props {
  settings: AppSettings;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

const STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  interrupted: '已中断',
  paused: '已暂停',
  created: '已创建',
  running: '运行中',
};

const STATUS_COLORS: Record<string, string> = {
  completed: 'var(--success)',
  failed: 'var(--error)',
  interrupted: 'var(--error)',
  paused: 'var(--warning)',
  running: 'var(--accent)',
};

const STORAGE_RECENT_JOBS = 'inkmigrate-recent-jobs';

function getStoredRecentJobs(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_RECENT_JOBS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecentJob(jobId: string) {
  try {
    const existing = getStoredRecentJobs();
    const updated = [jobId, ...existing.filter((id) => id !== jobId)].slice(0, 8);
    localStorage.setItem(STORAGE_RECENT_JOBS, JSON.stringify(updated));
  } catch {
    // 忽略存储异常
  }
}

export function ReportPage({ settings, rpcCall }: Props) {
  const [selectedJob, setSelectedJob] = useState('');
  const [detail, setDetail] = useState<StatusQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentJobs, setRecentJobs] = useState<string[]>([]);

  useEffect(() => {
    const list = getStoredRecentJobs();
    setRecentJobs(list);
    // 默认自动查询最近一次的任务
    if (list.length > 0 && !selectedJob) {
      setSelectedJob(list[0]);
    }
  }, []);

  const queryJob = useCallback(async (jobIdToQuery?: string) => {
    const targetJob = (jobIdToQuery ?? selectedJob).trim();
    if (!targetJob || !settings.stateDir) return;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const res = (await rpcCall('status.query', {
        job: targetJob,
        stateDir: settings.stateDir,
      })) as StatusQueryResult;

      if (
        typeof res?.status !== 'string' ||
        [res.scanCount, res.verifiedCount, res.degradedCount, res.failedCount].some(
          (n) => typeof n !== 'number'
        )
      ) {
        throw new Error('status.query 返回数据格式异常');
      }
      setDetail(res);
      saveRecentJob(targetJob);
      setRecentJobs(getStoredRecentJobs());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedJob, settings.stateDir, rpcCall]);

  const handleOpenReportsDir = async () => {
    if (!settings.stateDir || !selectedJob) return;
    const reportDir = `${settings.stateDir}/reports/${selectedJob}`;
    try {
      await invoke('open_in_folder', { path: reportDir });
    } catch (err) {
      console.warn('打开报告目录失败:', err);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <BarChart3 size={20} />
        <span>迁移报告与审计</span>
      </h2>

      <div style={{ padding: '18px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '14px', border: '1px solid var(--border)' }}>
        <label htmlFor="report-job-id" style={{ fontSize: '13px', fontWeight: 500 }}>
          选择历史任务或输入 Job ID 查询
        </label>

        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            id="report-job-id"
            value={selectedJob}
            onChange={(e) => {
              setSelectedJob(e.target.value);
              setDetail(null);
              setError(null);
            }}
            placeholder="例如 mig-1710000000"
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button
            onClick={() => void queryJob()}
            disabled={loading || !selectedJob.trim() || !settings.stateDir}
            className="btn-primary"
            style={{ minWidth: '90px' }}
          >
            <Search size={14} />
            <span>{loading ? '查询中...' : '查询'}</span>
          </button>
        </div>

        {/* 最近执行的任务快速选择 */}
        {recentJobs.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
            <span style={{ color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <History size={13} />
              <span>历史任务:</span>
            </span>
            {recentJobs.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setSelectedJob(id);
                  void queryJob(id);
                }}
                className={selectedJob === id ? 'btn-secondary btn-sm' : 'btn-ghost btn-sm'}
                style={{
                  fontFamily: 'monospace',
                  fontSize: '11px',
                  padding: '2px 8px',
                  background: selectedJob === id ? 'var(--bg-hover)' : 'rgba(255,255,255,0.04)',
                }}
              >
                {id}
              </button>
            ))}
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

        {detail && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
                任务详情：<code style={{ color: 'var(--text)', fontWeight: 600 }}>{selectedJob}</code>
              </div>
              <button
                type="button"
                onClick={handleOpenReportsDir}
                className="btn-secondary btn-sm"
                title="在系统文件管理器中定位该任务的详细报告目录"
              >
                <FolderOpen size={13} />
                <span>在访达 / 资源管理器中打开报告</span>
                <ExternalLink size={12} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
              <StatCard label="任务状态" value={STATUS_LABELS[detail.status] ?? detail.status} color={STATUS_COLORS[detail.status] ?? 'var(--warning)'} />
              <StatCard label="扫描总数" value={String(detail.scanCount)} />
              <StatCard label="已验证落盘" value={String(detail.verifiedCount)} color="var(--success)" />
              <StatCard label="格式降级" value={String(detail.degradedCount)} color="var(--warning)" />
              <StatCard label="冲突/跳过" value={String((detail.conflictCount ?? 0) + (detail.skippedCount ?? 0))} color="var(--text-dim)" />
              <StatCard label="处理失败" value={String(detail.failedCount)} color="var(--error)" />
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6' }}>
        💡 提示：每次迁移任务均会在本地生成详细对账报告。<br />
        详细清单文件（<code>summary.md</code>、<code>items.csv</code>）保存在：<br />
        <code style={{ fontSize: '11px', color: 'var(--text)' }}>
          {settings.stateDir ? `${settings.stateDir}/reports/<job-id>/` : '~/.inkmigrate/reports/<job-id>/'}
        </code>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}
