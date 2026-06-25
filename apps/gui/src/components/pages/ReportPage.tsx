import { useState, useEffect } from 'react';
import type { AppSettings } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

interface JobInfo {
  jobId: string;
  status: string;
  scanCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
}

export function ReportPage({ settings, rpcCall }: Props) {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>('');
  const [detail, setDetail] = useState<JobInfo | null>(null);
  const [loading, setLoading] = useState(false);

  // 暂时只能查询单个 job。未来可以加一个 list jobs 的 RPC
  async function queryJob() {
    if (!selectedJob || !settings.stateDir) return;
    setLoading(true);
    try {
      const res = await rpcCall('status.query', {
        job: selectedJob,
        stateDir: settings.stateDir,
      }) as JobInfo;
      setDetail(res);
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>迁移报告</h2>

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <label style={{ fontSize: '13px' }}>输入 Job ID 查询状态</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            value={selectedJob}
            onChange={(e) => setSelectedJob(e.target.value)}
            placeholder="mig-xxxxxxxxxxxx"
            style={{ flex: 1 }}
          />
          <button onClick={queryJob} disabled={loading || !selectedJob || !settings.stateDir}>
            查询
          </button>
        </div>

        {detail && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '8px' }}>
              Job: {detail.jobId}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
              <StatCard label="状态" value={detail.status} color={detail.status === 'completed' ? 'var(--success)' : 'var(--warning)'} />
              <StatCard label="扫描总数" value={String(detail.scanCount)} />
              <StatCard label="已验证" value={String(detail.verifiedCount)} color="var(--success)" />
              <StatCard label="降级" value={String(detail.degradedCount)} color="var(--warning)" />
              <StatCard label="失败" value={String(detail.failedCount)} color="var(--error)" />
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
        提示：详细报告文件（summary.md、items.csv）保存在<br/>
        <code>{settings.stateDir}/reports/{'<job-id>'}/</code>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: '10px', background: 'var(--bg-hover)', borderRadius: '6px', textAlign: 'center' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}
