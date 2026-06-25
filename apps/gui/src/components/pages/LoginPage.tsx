import { useState } from 'react';
import type { AppSettings, OperationState } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function LoginPage({ settings, update, rpcCall, addLog }: Props) {
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
      }) as { state: string; favoritesUrl?: string };
      const ok = result.state === 'logged-in';
      setLoginState(ok ? 'success' : 'failed');
      addLog(ok ? 'info' : 'error', `登录结果：${result.state}`);
      if (ok) {
        // 登录成功后自动填充收藏页 URL
        if (result.favoritesUrl) {
          update({ favoritesUrl: result.favoritesUrl });
          addLog('info', `已自动获取收藏页 URL`);
        }
        await checkStatus();
      }
    } catch (e) {
      setLoginState('failed');
      const errMsg = e instanceof Error ? e.message : String(e);
      addLog('error', `登录失败：${errMsg}`);
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
      addLog('error', `清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>登录今日头条</h2>

      {/* 快速配置：如果 stateDir 为空，在这里直接填写 */}
      {!settings.stateDir && (
        <div style={{
          padding: '16px',
          background: 'rgba(243, 156, 18, 0.1)',
          borderRadius: '8px',
          border: '1px solid rgba(243, 156, 18, 0.3)',
        }}>
          <div style={{ fontWeight: 600, marginBottom: '12px' }}>⚠️ 请先配置工作区目录</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>工作区目录 (stateDir)</label>
              <input
                value={settings.stateDir}
                onChange={(e) => update({ stateDir: e.target.value })}
                placeholder="~/.inkmigrate"
              />
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
                存放数据库、登录 Profile、报告的目录。例如 /Users/you/inkmigrate
              </div>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
              💡 收藏页 URL 会在登录成功后自动获取，无需手动填写。
            </div>
          </div>
        </div>
      )}

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
            {loading ? '处理中...' : loginState === 'success' ? '重新登录' : '打开浏览器登录'}
          </button>
          <button onClick={handleClear} disabled={loading || !profilePath} className="btn-danger">
            清除登录
          </button>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6' }}>
          点击登录后会打开浏览器窗口，请在浏览器中扫码完成登录。
          登录成功后 Profile 会自动保存，后续操作不需要重新登录。
        </div>
      </div>

      {settings.stateDir && (
        <button onClick={checkStatus} disabled={loading} style={{ alignSelf: 'flex-start' }}>
          检查登录状态
        </button>
      )}
    </div>
  );
}
