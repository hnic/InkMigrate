import { useState } from 'react';
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
import type { PageId } from './lib/types.js';

export default function App() {
  const [page, setPage] = useState<PageId>('login');
  const { settings, update } = useSettings();
  const { rpcCall, progress, logs, busy, activePhase, healthDegraded, addLog, cancel } = useSidecar();
  const { refresh: refreshLogin, profilePath } = useLoginStatus({ settings, update });
  // Evernote 文件源无登录/清理步骤：login 与 cleanup 页均重定向到扫描
  const isEvernote = settings.sourceAdapter === 'evernote';
  const effectivePage: PageId =
    isEvernote && (page === 'login' || page === 'cleanup') ? 'scan' : page;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* 顶栏 */}
      <header style={{
        padding: '8px 16px',
        background: 'var(--bg-panel)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderBottom: '1px solid var(--border)',
      }}>
        <img src="/logo.png" alt="InkMigrate 墨迁" style={{ width: '20px', height: '20px', borderRadius: '4px' }} />
        <span style={{ fontWeight: 700, fontSize: '16px' }}>InkMigrate 墨迁</span>
        <span style={{ flex: 1 }} />
        {/* evernote 文件源无登录流程，不显示登录指示（否则永远误显示「未登录」） */}
        {settings.stateDir && !isEvernote && (
          <span style={{
            fontSize: '12px',
            color: settings.loggedIn ? 'var(--success)' : 'var(--text-dim)',
          }}>
            ● {settings.loggedIn ? '已登录' : '未登录'}
          </span>
        )}
        {busy && <span style={{ color: 'var(--warning)', fontSize: '12px' }}>● 处理中</span>}
      </header>

      {/* 主区域 */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 侧边栏 */}
        <aside style={{
          padding: '12px 8px',
          background: 'var(--bg-panel)',
          borderRight: '1px solid var(--border)',
        }}>
          <Sidebar current={effectivePage} onSelect={setPage} sourceAdapter={settings.sourceAdapter} />
        </aside>

        {/* 内容区 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px', gap: '12px', overflow: 'hidden' }}>
          {/* 引擎降级提示（uncaughtException 后显示，需重启应用解除） */}
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
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {effectivePage === 'login' && <LoginPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} refreshLogin={refreshLogin} profilePath={profilePath} />}
            {effectivePage === 'scan' && <ScanPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} activePhase={activePhase} cancel={cancel} />}
            {effectivePage === 'migrate' && <MigratePage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} activePhase={activePhase} cancel={cancel} />}
            {effectivePage === 'cleanup' && <CleanupPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} busy={busy} activePhase={activePhase} cancel={cancel} />}
            {effectivePage === 'report' && <ReportPage settings={settings} rpcCall={rpcCall} />}
            {effectivePage === 'settings' && <SettingsPage settings={settings} update={update} />}
          </div>

          {/* 日志面板（始终显示在底部） */}
          <div style={{ height: '180px', flexShrink: 0 }}>
            <LogPanel logs={logs} />
          </div>
        </main>
      </div>
    </div>
  );
}
