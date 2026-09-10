import { useState } from 'react';
import type { AppSettings, StatusQueryResult } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

// R3-M5: 改用共享 StatusQueryResult 类型（原 JobInfo 重声明且含不存在的 jobId 字段，
// handler 不返回 jobId，渲染 Job: {undefined}）。jobId 显示用客户端 selectedJob。

// 状态文案/配色（模块级常量）：paused 对齐 engine 的 JobStatus 联合，避免回退英文原文
const STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  interrupted: '已中断',
  paused: '已暂停',
  created: '已创建',
  running: '运行中',
};
// 状态语义配色：失败/中断用 error 色，与下方「失败」计数卡的颜色语义一致
const STATUS_COLORS: Record<string, string> = {
  completed: 'var(--success)',
  failed: 'var(--error)',
  interrupted: 'var(--error)',
};

export function ReportPage({ settings, rpcCall }: Props) {
  const [selectedJob, setSelectedJob] = useState('');
  const [detail, setDetail] = useState<StatusQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function queryJob() {
    if (!selectedJob || !settings.stateDir) return;
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const res = await rpcCall('status.query', {
        job: selectedJob,
        stateDir: settings.stateDir,
      }) as StatusQueryResult;
      // 运行时校验关键字段：协议漂移时给出明确错误，而不是卡片渲染出 undefined
      if (
        typeof res?.status !== 'string' ||
        [res.scanCount, res.verifiedCount, res.degradedCount, res.failedCount].some(
          (n) => typeof n !== 'number',
        )
      ) {
        throw new Error('status.query 返回数据格式异常（engine/GUI 版本可能不匹配）');
      }
      setDetail(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
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
            onChange={(e) => {
              setSelectedJob(e.target.value);
              // 输入变化即作废旧结果：否则旧 Job 的数据会被标上未查询过的新 Job ID
              setDetail(null);
              setError(null);
            }}
            placeholder="mig-xxxxxxxxxxxx"
            style={{ flex: 1 }}
          />
          <button onClick={queryJob} disabled={loading || !selectedJob || !settings.stateDir}>
            {loading ? '查询中...' : '查询'}
          </button>
        </div>

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

        {detail && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '8px' }}>
              Job: {selectedJob}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
              <StatCard label="状态" value={STATUS_LABELS[detail.status] ?? detail.status} color={STATUS_COLORS[detail.status] ?? 'var(--warning)'} />
              <StatCard label="扫描总数" value={String(detail.scanCount)} />
              <StatCard label="已验证" value={String(detail.verifiedCount)} color="var(--success)" />
              <StatCard label="降级" value={String(detail.degradedCount)} color="var(--warning)" />
              <StatCard label="失败" value={String(detail.failedCount)} color="var(--error)" />
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
        提示：Job ID 可在迁移页面的结果中查看。<br/>
        详细报告文件（summary.md、items.csv）保存在<br/>
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
