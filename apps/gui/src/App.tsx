import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { ProgressBar } from './components/ProgressBar.js';
import { LogPanel } from './components/LogPanel.js';
import { LoginPage } from './components/pages/LoginPage.js';
import { ScanPage } from './components/pages/ScanPage.js';
import { MigratePage } from './components/pages/MigratePage.js';
import { CleanupPage } from './components/pages/CleanupPage.js';
import { ReportPage } from './components/pages/ReportPage.js';
import { SettingsPage } from './components/pages/SettingsPage.js';
import { useSettings } from './hooks/useSettings.js';
import { useSidecar } from './hooks/useSidecar.js';
import { useLoginStatus } from './hooks/useLoginStatus.js';
import type { PageId, SourceAdapterKind } from './lib/types.js';
import { getSourceSwitchPatch } from './lib/gui-helpers.js';
import { Layers } from 'lucide-react';

const isMac = /Mac/i.test(navigator.userAgent);

export default function App() {
  const [page, setPage] = useState<PageId>('login');
  const [logCollapsed, setLogCollapsed] = useState(true);

  const { settings, update } = useSettings();
  const { rpcCall, progress, logs, busy, activePhase, healthDegraded, addLog, cancel, clearLogs } = useSidecar();
  const { refresh: refreshLogin, profilePath } = useLoginStatus({ settings, update });

  const isEvernote = settings.sourceAdapter === 'evernote';
  const effectivePage: PageId =
    isEvernote && (page === 'login' || page === 'cleanup') ? 'scan' : page;

  // 任务开始运行时自动展开日志抽屉方便观察，完成后不强制折叠
  useEffect(() => {
    if (busy) {
      setLogCollapsed(false);
    }
  }, [busy]);

  const handleSourceChange = (adapter: SourceAdapterKind) => {
    update(getSourceSwitchPatch(adapter));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      {/* 顶栏：兼作窗口拖拽区 */}
      <header
        data-tauri-drag-region
        style={{
          padding: `8px 16px 8px ${isMac ? 78 : 16}px`,
          background: 'var(--bg-panel)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          borderBottom: '1px solid var(--border)',
          height: '46px',
        }}
      >
        <img src="/logo.png" alt="InkMigrate 墨迁" style={{ width: '20px', height: '20px', borderRadius: '4px', pointerEvents: 'none' }} />
        <span style={{ fontWeight: 700, fontSize: '15px', pointerEvents: 'none' }}>InkMigrate 墨迁</span>

        {/* 顶部轻量来源切换器 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '12px' }}>
          <Layers size={14} color="var(--text-dim)" />
          <select
            value={settings.sourceAdapter ?? 'toutiao'}
            onChange={(e) => handleSourceChange(e.target.value as SourceAdapterKind)}
            style={{
              padding: '2px 8px',
              fontSize: '12px',
              height: '26px',
              width: '160px',
              background: 'var(--bg)',
              borderColor: 'var(--border)',
            }}
          >
            <option value="toutiao">今日头条</option>
            <option value="evernote">Evernote / 印象笔记</option>
          </select>
        </div>

        <span style={{ flex: 1, pointerEvents: 'none' }} />

        {/* 登录与运行指示 */}
        {settings.stateDir && !isEvernote && (
          <span
            className={`badge ${settings.loggedIn ? 'badge-success' : 'badge-neutral'}`}
            style={{ pointerEvents: 'none' }}
          >
            ● {settings.loggedIn ? '已登录' : '未登录'}
          </span>
        )}
        {busy && (
          <span className="badge badge-warning" style={{ pointerEvents: 'none' }}>
            ● 处理中 ({activePhase ?? 'busy'})
          </span>
        )}
      </header>

      {/* 主区域 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 侧边栏 */}
        <aside style={{
          padding: '12px 10px',
          background: 'var(--bg-panel)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}>
          <Sidebar current={effectivePage} onSelect={setPage} sourceAdapter={settings.sourceAdapter} />
        </aside>

        {/* 内容区 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '16px 20px', gap: '12px', overflow: 'hidden' }}>
          {/* 引擎降级提示 */}
          {healthDegraded !== null && (
            <div role="alert" style={{
              padding: '10px 14px',
              background: 'var(--error-hover)',
              color: '#fff',
              borderRadius: '6px',
              fontSize: '13px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}>
              <strong>⚠️ 引擎状态已降级</strong>
              <span>新任务已暂停。建议保存当前状态并<span style={{ fontWeight: 700 }}>重启应用</span>后再继续。</span>
              <details style={{ marginTop: '2px' }}>
                <summary style={{ cursor: 'pointer', opacity: 0.9 }}>详细信息</summary>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: '11px', opacity: 0.85 }}>
                  {healthDegraded.stack ?? healthDegraded.message}
                </pre>
              </details>
            </div>
          )}

          {/* 进度条（有活跃任务时显示） */}
          <ProgressBar progress={progress} />

          {/* 当前页面 */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: '4px' }}>
            {effectivePage === 'login' && (
              <LoginPage
                settings={settings}
                update={update}
                rpcCall={rpcCall}
                addLog={addLog}
                refreshLogin={refreshLogin}
                profilePath={profilePath}
                onNavigate={setPage}
              />
            )}
            {effectivePage === 'scan' && (
              <ScanPage
                settings={settings}
                update={update}
                rpcCall={rpcCall}
                addLog={addLog}
                activePhase={activePhase}
                cancel={cancel}
                onNavigate={setPage}
              />
            )}
            {effectivePage === 'migrate' && (
              <MigratePage
                settings={settings}
                update={update}
                rpcCall={rpcCall}
                addLog={addLog}
                activePhase={activePhase}
                cancel={cancel}
                onNavigate={setPage}
              />
            )}
            {effectivePage === 'cleanup' && (
              <CleanupPage
                settings={settings}
                update={update}
                rpcCall={rpcCall}
                addLog={addLog}
                busy={busy}
                activePhase={activePhase}
                cancel={cancel}
              />
            )}
            {effectivePage === 'report' && <ReportPage settings={settings} rpcCall={rpcCall} />}
            {effectivePage === 'settings' && <SettingsPage settings={settings} update={update} />}
          </div>

          {/* 可折叠的底部日志面板抽屉 */}
          <div style={{
            height: logCollapsed ? '36px' : '190px',
            flexShrink: 0,
            transition: 'height 0.2s ease',
          }}>
            <LogPanel
              logs={logs}
              collapsed={logCollapsed}
              onToggleCollapse={() => setLogCollapsed((prev) => !prev)}
              onClear={clearLogs}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
