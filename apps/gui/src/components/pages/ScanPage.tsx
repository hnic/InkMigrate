import { useState } from 'react';
import type { AppSettings } from '../../lib/types.js';
import { ConfigPrompt } from '../ConfigPrompt.js';

/** 问题清单最多展示条数（超出截断并提示剩余数量）。 */
const MAX_ISSUES_SHOWN = 5;

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 当前运行的 phase：按钮禁用改由 activePhase 判定（避免登录收尾的 busy 锁住扫描）。 */
  activePhase: string | null;
  /** 终止当前正在运行的长任务。 */
  cancel: () => Promise<void>;
}

export function ScanPage({ settings, update, rpcCall, addLog, activePhase, cancel }: Props) {
  if (settings.sourceAdapter === 'evernote') {
    return <EvernotePreview settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} />;
  }
  return <ToutiaoScan settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} activePhase={activePhase} cancel={cancel} />;
}

/** §15 Evernote 文件源预览：条目数 + 笔记本分布 + 问题清单（不写库）。 */
function EvernotePreview({ settings, update, rpcCall, addLog }: Omit<Props, 'activePhase' | 'cancel'>) {
  const [result, setResult] = useState<{
    uniqueItems: number;
    byNotebook: Record<string, number>;
    issues: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePreview() {
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const res = (await rpcCall('scan.preview', {
        source: settings.source,
        stateDir: settings.stateDir,
        configPath: settings.configPath,
      })) as {
        uniqueItems?: number;
        byNotebook?: Record<string, number>;
        issues?: string[];
      };
      // 响应字段做容错归一，避免后端缺字段时渲染路径抛错
      setResult({
        uniqueItems: res.uniqueItems ?? 0,
        byNotebook: res.byNotebook ?? {},
        issues: Array.isArray(res.issues) ? res.issues : [],
      });
      addLog('info', `预览完成：${res.uniqueItems ?? 0} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `预览失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>扫描预览（Evernote）</h2>

      <ConfigPrompt
        settings={settings}
        update={update}
        required={['stateDir']}
        message="⚠️ 请先在设置页填写工作区目录"
      />

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-dim)' }}>
          读取配置指向的 ENEX/HTML 导出并统计条目数与笔记本分布。纯预览，不写数据库。
        </div>

        <button onClick={handlePreview} disabled={busy || !settings.stateDir || !settings.configPath}>
          {busy ? '预览中...' : '开始预览'}
        </button>

        {!settings.configPath && (
          <div style={{ fontSize: '13px', color: 'var(--warning)' }}>
            ⚠️ 请先在「设置」页填写配置文件（inkmigrate.yaml）路径
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
          <div style={{ marginTop: '8px', padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div>
              <span style={{ fontSize: '24px', fontWeight: 700, color: 'var(--success)' }}>
                {result.uniqueItems}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}> 个条目</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '13px' }}>
              {Object.entries(result.byNotebook)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([nb, count]) => (
                  <div key={nb} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>📁 {nb}</span>
                    <span style={{ color: 'var(--text-dim)' }}>{count} 条</span>
                  </div>
                ))}
            </div>
            {result.issues.length > 0 && (
              <div style={{ fontSize: '12px', color: 'var(--warning)', whiteSpace: 'pre-wrap' }}>
                ⚠️ {result.issues.length} 条注意事项：
                {'\n'}
                {result.issues.slice(0, MAX_ISSUES_SHOWN).join('\n')}
                {result.issues.length > MAX_ISSUES_SHOWN ? `\n…还有 ${result.issues.length - MAX_ISSUES_SHOWN} 条未显示` : ''}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToutiaoScan({ settings, update, rpcCall, addLog, activePhase, cancel }: Props) {
  const scanning = activePhase === 'scanning';
  // 本地同步重入守卫：activePhase 要等 setState 重渲染后才生效，
  // 快速双击会在按钮禁用前重复触发 scan.start
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ uniqueItems: number; terminationReason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 文案不锁定轮数上限：上限由 engine 控制（key 中的 5 仅为原因标识），改配置时文案不漂移
  const reasonLabels: Record<string, string> = {
    no_new_items_after_5_cycles: '连续多轮无新内容',
    no_load_more: '没有更多内容',
    cancelled: '已终止',
  };

  async function handleScan() {
    if (busy || scanning) return;
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const res = await rpcCall('scan.start', {
        source: settings.source,
        stateDir: settings.stateDir,
        favoritesUrl: settings.favoritesUrl,
      }) as { uniqueItems?: number; terminationReason?: string };
      // 响应字段做容错归一，避免后端缺字段时渲染路径抛错
      setResult({
        uniqueItems: res.uniqueItems ?? 0,
        terminationReason: res.terminationReason ?? '',
      });
      addLog('info', `扫描完成：${res.uniqueItems ?? 0} 条`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      addLog('error', `扫描失败：${msg}`);
    } finally {
      setBusy(false);
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
          <button onClick={handleScan} disabled={busy || scanning || !settings.stateDir || !settings.favoritesUrl || !settings.loggedIn}>
            {scanning ? '扫描中...' : '开始扫描'}
          </button>
          <button onClick={() => void cancel()} disabled={!scanning} className="btn-danger">
            终止
          </button>
        </div>

        {/* favoritesUrl 缺失时给出可读提示，避免按钮灰着却无解释 */}
        {settings.stateDir && !settings.favoritesUrl && (
          <div style={{ fontSize: '13px', color: 'var(--warning)' }}>
            ⚠️ 请先在「设置」页填写收藏列表 URL（登录成功后通常会自动获取）
          </div>
        )}

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
