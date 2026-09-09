import { useState } from 'react';
import type { AppSettings, OperationState, AuthLoginResult } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 应用级登录态刷新（由 useLoginStatus 提供）。静默，不触发 busy。 */
  refreshLogin: () => Promise<void>;
  /** Profile 路径（由 useLoginStatus 的 auth.status 顺带返回，避免本页重复查询）。 */
  profilePath: string;
}

/** 状态点颜色 / 文案（process 态优先，否则对齐 settings.loggedIn）。 */
const STATUS_COLOR: Record<OperationState, string> = {
  success: 'var(--success)',
  failed: 'var(--error)',
  loading: 'var(--warning)',
  idle: 'var(--text-dim)',
};
const STATUS_TEXT: Record<OperationState, string> = {
  success: '已登录',
  failed: '登录失败',
  loading: '登录中...',
  idle: '未登录',
};

export function LoginPage({ settings, update, rpcCall, addLog, refreshLogin, profilePath }: Props) {
  // loginState 现在只承载【过程态】：登录中 / 登录失败。
  // 稳定态（已登录/未登录）由 settings.loggedIn 驱动，与顶栏保持单一真相源。
  const [loginState, setLoginState] = useState<OperationState>('idle');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setLoading(true);
    setLoginState('loading');
    try {
      const result = await rpcCall('auth.login', {
        source: settings.source,
        stateDir: settings.stateDir,
        ...(settings.favoritesUrl ? { favoritesUrl: settings.favoritesUrl } : {}),
      }) as AuthLoginResult;
      if (typeof result?.state !== 'string') {
        throw new Error('登录响应格式异常（缺少 state 字段）');
      }
      const ok = result.state === 'logged-in';
      // 过程态归位：稳定显示交给 settings.loggedIn（由 refreshLogin 写入）
      setLoginState(ok ? 'idle' : 'failed');
      addLog(ok ? 'info' : 'error', `登录结果：${result.state}`);
      if (ok) {
        // 登录成功后自动填充收藏页 URL
        if (result.favoritesUrl) {
          update({ favoritesUrl: result.favoritesUrl });
          addLog('info', `已自动获取收藏页 URL`);
        }
        try {
          await refreshLogin();
        } catch (e) {
          // 登录本身已成功，刷新失败不应误报为「登录失败」
          addLog('warn', `登录成功，但刷新登录状态失败：${e instanceof Error ? e.message : String(e)}`);
        }
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
    setLoginState('loading');
    try {
      const result = await rpcCall('auth.clear', {
        source: settings.source,
        stateDir: settings.stateDir,
      }) as { cleared?: boolean };
      if (typeof result?.cleared !== 'boolean') {
        throw new Error('清除响应格式异常（缺少 cleared 字段）');
      }
      addLog('info', result.cleared ? 'Profile 已删除' : 'Profile 不存在');
      try {
        await refreshLogin();
      } catch (e) {
        // 清除本身已成功，刷新失败不应误报为「清除失败」
        addLog('warn', `Profile 已清除，但刷新登录状态失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      addLog('error', `清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // 过程态归位，稳定态交回 settings.loggedIn
      setLoginState('idle');
      setLoading(false);
    }
  }

  // 卡片显示判定：过程态（loading/failed）优先，否则对齐 settings.loggedIn
  let displayState: OperationState = 'idle';
  if (loginState === 'loading' || loginState === 'failed') {
    displayState = loginState;
  } else if (settings.loggedIn) {
    displayState = 'success';
  }
  const statusColor = STATUS_COLOR[displayState];
  const statusText = STATUS_TEXT[displayState];

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
            background: statusColor,
          }} />
          <span>{statusText}</span>
        </div>

        {profilePath && (
          <div style={{ color: 'var(--text-dim)', fontSize: '12px', wordBreak: 'break-all' }}>
            Profile: {profilePath}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleLogin} disabled={loading || !settings.stateDir}>
            {loading ? '处理中...' : settings.loggedIn ? '重新登录' : '打开浏览器登录'}
          </button>
          <button onClick={handleClear} disabled={loading || !settings.loggedIn} className="btn-danger">
            清除登录
          </button>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6' }}>
          点击登录后会打开浏览器窗口，请在浏览器中扫码完成登录。
          登录成功后 Profile 会自动保存，后续操作不需要重新登录。
        </div>
      </div>

      {settings.stateDir && (
        <button onClick={() => void refreshLogin()} disabled={loading} style={{ alignSelf: 'flex-start' }}>
          检查登录状态
        </button>
      )}
    </div>
  );
}
