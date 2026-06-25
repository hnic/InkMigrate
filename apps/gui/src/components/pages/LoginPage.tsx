import { useState } from 'react';
import type { AppSettings, OperationState } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function LoginPage({ settings, rpcCall, addLog }: Props) {
  const [loginState, setLoginState] = useState<OperationState>('idle');
  const [profilePath, setProfilePath] = useState('');
  const [loading, setLoading] = useState(false);

  async function checkStatus() {
    try {
      const result = await rpcCall('auth.status', {
        source: settings.source,
        stateDir: settings.stateDir,
      }) as { profileExists: boolean; profilePath: string };
      setProfilePath(result.profileExists ? result.profilePath : '');
      setLoginState(result.profileExists ? 'success' : 'idle');
    } catch {
      // ignore
    }
  }

  async function handleLogin() {
    setLoading(true);
    setLoginState('loading');
    try {
      const result = await rpcCall('auth.login', {
        source: settings.source,
        stateDir: settings.stateDir,
        ...(settings.favoritesUrl ? { favoritesUrl: settings.favoritesUrl } : {}),
      }) as { state: string };
      const ok = result.state === 'logged-in';
      setLoginState(ok ? 'success' : 'failed');
      addLog(ok ? 'info' : 'error', `登录结果：${result.state}`);
      if (ok) await checkStatus();
    } catch (e) {
      setLoginState('failed');
      addLog('error', `登录失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleClear() {
    setLoading(true);
    try {
      const result = await rpcCall('auth.clear', {
        source: settings.source,
        stateDir: settings.stateDir,
      }) as { cleared: boolean };
      addLog('info', result.cleared ? 'Profile 已删除' : 'Profile 不存在');
      setProfilePath('');
      setLoginState('idle');
    } catch (e) {
      addLog('error', `清除失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>登录今日头条</h2>

      <div style={{
        padding: '16px',
        background: 'var(--bg-panel)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{
            width: '12px', height: '12px', borderRadius: '50%',
            background: loginState === 'success' ? 'var(--success)' :
                       loginState === 'failed' ? 'var(--error)' :
                       loginState === 'loading' ? 'var(--warning)' : 'var(--text-dim)',
          }} />
          <span>
            {loginState === 'success' ? '已登录' :
             loginState === 'failed' ? '登录失败' :
             loginState === 'loading' ? '登录中...' : '未登录'}
          </span>
        </div>

        {profilePath && (
          <div style={{ color: 'var(--text-dim)', fontSize: '12px', wordBreak: 'break-all' }}>
            Profile: {profilePath}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleLogin} disabled={loading || !settings.stateDir}>
            {loginState === 'success' ? '重新登录' : '打开浏览器登录'}
          </button>
          <button onClick={handleClear} disabled={loading || !profilePath} style={{ background: 'var(--error)' }}>
            清除登录
          </button>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6' }}>
          点击登录后会打开浏览器窗口，请在浏览器中扫码完成登录。
          登录成功后 Profile 会自动保存，后续操作不需要重新登录。
        </div>
      </div>

      <button onClick={checkStatus} disabled={loading || !settings.stateDir} style={{ alignSelf: 'flex-start' }}>
        检查登录状态
      </button>
    </div>
  );
}
