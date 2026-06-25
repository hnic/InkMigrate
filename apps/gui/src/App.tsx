import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * InkMigrate GUI 主界面。
 *
 * 通过 Tauri IPC 调用 Rust 后端的 send_rpc command，
 * Rust 后端转发到 Node sidecar 的 JSON-RPC 接口。
 */

interface ProgressEvent {
  jobId?: string;
  phase: string;
  current: number;
  total: number;
  currentItem?: string;
}

export default function App() {
  const [stateDir, setStateDir] = useState('');
  const [vaultPath, setVaultPath] = useState('');
  const [favoritesUrl, setFavoritesUrl] = useState('');
  const [source] = useState('toutiao-main');
  const [target] = useState('obsidian-main');

  const [loginState, setLoginState] = useState<'idle' | 'loading' | 'success' | 'failed'>('idle');
  const [profilePath, setProfilePath] = useState('');
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // 监听 sidecar 事件
  useEffect(() => {
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenLog: UnlistenFn | undefined;

    listen<ProgressEvent>('sidecar://progress', (e) => {
      setProgress(e.payload);
    }).then((fn) => { unlistenProgress = fn; });

    listen<{ level: string; message: string }>('sidecar://log', (e) => {
      setLogs((prev) => [...prev.slice(-100), `[${e.payload.level}] ${e.payload.message}`]);
    }).then((fn) => { unlistenLog = fn; });

    return () => {
      unlistenProgress?.();
      unlistenLog?.();
    };
  }, []);

  async function rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    return invoke('send_rpc', { method, params });
  }

  async function handleLogin() {
    setBusy(true);
    setLoginState('loading');
    try {
      const result = await rpcCall('auth.login', {
        source,
        stateDir,
        favoritesUrl: favoritesUrl || undefined,
      }) as { state: string };
      setLoginState(result.state === 'logged-in' ? 'success' : 'failed');
      await checkAuthStatus();
    } catch (e) {
      setLoginState('failed');
      setLogs((prev) => [...prev, `[error] ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  }

  async function checkAuthStatus() {
    try {
      const result = await rpcCall('auth.status', { source, stateDir }) as { profileExists: boolean; profilePath: string };
      setProfilePath(result.profileExists ? result.profilePath : '');
    } catch {
      // ignore
    }
  }

  async function handleScan() {
    setBusy(true);
    setProgress(null);
    try {
      const result = await rpcCall('scan.start', {
        source,
        stateDir,
        favoritesUrl,
      }) as { uniqueItems: number };
      setLogs((prev) => [...prev, `[info] 扫描完成：${result.uniqueItems} 条`]);
    } catch (e) {
      setLogs((prev) => [...prev, `[error] ${(e as Error).message}`]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleMigrate() {
    setBusy(true);
    setProgress(null);
    try {
      const result = await rpcCall('migrate.start', {
        source,
        target,
        stateDir,
        vaultPath,
        favoritesUrl: favoritesUrl || undefined,
      }) as { status: string; scanCount: number; reconciliationOk: boolean };
      setLogs((prev) => [...prev, `[info] 迁移完成：status=${result.status}, count=${result.scanCount}, reconcile=${result.reconciliationOk}`]);
    } catch (e) {
      setLogs((prev) => [...prev, `[error] ${(e as Error).message}`]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleCleanup() {
    setBusy(true);
    setProgress(null);
    try {
      const result = await rpcCall('cleanup.unfavorite', {
        source,
        stateDir,
      }) as { successCount: number; skipCount: number; failCount: number };
      setLogs((prev) => [...prev, `[info] 清理完成：成功 ${result.successCount}, 跳过 ${result.skipCount}, 失败 ${result.failCount}`]);
    } catch (e) {
      setLogs((prev) => [...prev, `[error] ${(e as Error).message}`]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', padding: '16px', gap: '16px' }}>
      {/* 左侧：配置 + 操作 */}
      <div style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h1 style={{ fontSize: '20px' }}>🔄 InkMigrate 墨迁</h1>

        {/* 配置 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label>工作区目录 (stateDir)</label>
          <input value={stateDir} onChange={(e) => setStateDir(e.target.value)} placeholder="~/.inkmigrate" />

          <label>Obsidian Vault 路径</label>
          <input value={vaultPath} onChange={(e) => setVaultPath(e.target.value)} placeholder="/path/to/vault" />

          <label>收藏页 URL</label>
          <input value={favoritesUrl} onChange={(e) => setFavoritesUrl(e.target.value)} placeholder="https://www.toutiao.com/c/user/token/..." />
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={handleLogin} disabled={busy || !stateDir}>
            {loginState === 'loading' ? '登录中...' : loginState === 'success' ? '✅ 已登录（重新登录）' : '登录头条'}
          </button>
          {profilePath && <span style={{ color: 'var(--text-dim)', fontSize: '12px' }}>Profile: {profilePath}</span>}

          <button onClick={handleScan} disabled={busy || !stateDir || !favoritesUrl}>
            扫描收藏
          </button>
          <button onClick={handleMigrate} disabled={busy || !stateDir || !vaultPath || !favoritesUrl}>
            迁移到 Obsidian
          </button>
          <button onClick={handleCleanup} disabled={busy || !stateDir}>
            取消收藏（清理）
          </button>
        </div>

        {/* 进度 */}
        {progress && (
          <div style={{ background: 'var(--bg-panel)', padding: '12px', borderRadius: '8px' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
              {progress.phase}: {progress.current}/{progress.total || '?'}
            </div>
            {progress.currentItem && <div style={{ color: 'var(--text-dim)' }}>{progress.currentItem}</div>}
          </div>
        )}
      </div>

      {/* 右侧：日志 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-panel)', borderRadius: '8px', padding: '12px' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>日志</div>
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.6' }}>
          {logs.length === 0 ? (
            <span style={{ color: 'var(--text-dim)' }}>等待操作...</span>
          ) : (
            logs.map((log, i) => <div key={i}>{log}</div>)
          )}
        </div>
      </div>
    </div>
  );
}
