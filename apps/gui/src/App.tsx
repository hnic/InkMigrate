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
  const { rpcCall, progress, logs, busy, activePhase, addLog, cancel } = useSidecar();
  const { refresh: refreshLogin } = useLoginStatus({ settings, update });

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
        <span style={{ fontSize: '18px' }}>🔄</span>
        <span style={{ fontWeight: 700, fontSize: '16px' }}>InkMigrate 墨迁</span>
        <span style={{ flex: 1 }} />
        {settings.stateDir && (
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
          <Sidebar current={page} onSelect={setPage} />
        </aside>

        {/* 内容区 */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px', gap: '12px', overflow: 'hidden' }}>
          {/* 进度条（有活跃任务时显示） */}
          <ProgressBar progress={progress} />

          {/* 当前页面 */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {page === 'login' && <LoginPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} refreshLogin={refreshLogin} />}
            {page === 'scan' && <ScanPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} busy={busy} activePhase={activePhase} cancel={cancel} />}
            {page === 'migrate' && <MigratePage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} busy={busy} activePhase={activePhase} cancel={cancel} />}
            {page === 'cleanup' && <CleanupPage settings={settings} update={update} rpcCall={rpcCall} addLog={addLog} busy={busy} activePhase={activePhase} cancel={cancel} />}
            {page === 'report' && <ReportPage settings={settings} rpcCall={rpcCall} />}
            {page === 'settings' && <SettingsPage settings={settings} update={update} />}
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
