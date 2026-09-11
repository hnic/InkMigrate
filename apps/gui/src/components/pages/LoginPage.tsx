import { useState } from 'react';
import type { AppSettings, OperationState, AuthLoginResult, PageId } from '../../lib/types.js';
import { normalizeFavoritesUrl, isSendableFavoritesUrl } from '../../lib/favorites-url.js';
import { PathInput } from '../PathInput.js';
import { LogIn, KeyRound, Trash2, RefreshCw, CheckCircle2, XCircle, Clock, ArrowRight, AlertTriangle } from 'lucide-react';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  rpcCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  refreshLogin: () => Promise<void>;
  profilePath: string;
  onNavigate?: (page: PageId) => void;
}

const STATUS_TEXT: Record<OperationState, string> = {
  success: '已登录（会话有效）',
  failed: '登录失败或已超时',
  loading: '登录中...',
  idle: '未登录',
};

export function LoginPage({ settings, update, rpcCall, addLog, refreshLogin, profilePath, onNavigate }: Props) {
  const [loginState, setLoginState] = useState<OperationState>('idle');
  const [loading, setLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function handleLogin() {
    setLoading(true);
    setLoginState('loading');
    try {
      const favoritesUrl = normalizeFavoritesUrl(settings.favoritesUrl);
      if (favoritesUrl !== '' && !isSendableFavoritesUrl(favoritesUrl)) {
        throw new Error(`收藏列表 URL 无法识别（需 http(s) 链接）：「${favoritesUrl}」，请在「设置」页修正`);
      }
      if (favoritesUrl !== settings.favoritesUrl && favoritesUrl !== '') {
        update({ favoritesUrl });
      }
      const result = (await rpcCall('auth.login', {
        source: settings.source,
        stateDir: settings.stateDir,
        ...(favoritesUrl !== '' ? { favoritesUrl } : {}),
      })) as AuthLoginResult;

      if (typeof result?.state !== 'string') {
        throw new Error('登录响应格式异常（缺少 state 字段）');
      }
      const ok = result.state === 'logged-in';
      if (!ok) {
        setLoginState('failed');
      }
      addLog(ok ? 'info' : 'error', `登录结果：${result.state}`);

      if (result.favoritesUrl) {
        update({ favoritesUrl: result.favoritesUrl });
        addLog('info', `已自动获取收藏列表 URL`);
      } else if (ok) {
        addLog('warn', '未能自动获取收藏列表 URL，请在「扫描」页或「设置」页手动填写');
      }
      if (ok) {
        try {
          await refreshLogin();
        } catch (e) {
          addLog('warn', `登录成功，但刷新登录状态失败：${e instanceof Error ? e.message : String(e)}`);
        }
        setLoginState('idle');
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
    setConfirmClear(false);
    setLoading(true);
    try {
      const result = (await rpcCall('auth.clear', {
        source: settings.source,
        stateDir: settings.stateDir,
      })) as { cleared?: boolean };
      if (typeof result?.cleared !== 'boolean') {
        throw new Error('清除响应格式异常（缺少 cleared 字段）');
      }
      addLog('info', result.cleared ? 'Profile 已删除' : 'Profile 不存在');
      try {
        await refreshLogin();
      } catch (e) {
        addLog('warn', `Profile 已清除，但刷新登录状态失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      addLog('error', `清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoginState('idle');
      setLoading(false);
    }
  }

  let displayState: OperationState = 'idle';
  if (loginState === 'loading') {
    displayState = 'loading';
  } else if (settings.loggedIn) {
    displayState = 'success';
  } else if (loginState === 'failed') {
    displayState = 'failed';
  }

  let loginLabel = settings.loggedIn ? '重新登录' : '打开浏览器登录';
  if (loading) loginLabel = '处理中...';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <KeyRound size={20} />
        <span>登录今日头条</span>
      </h2>

      {/* 快速配置：如果 stateDir 为空，在这里直接填写 */}
      {!settings.stateDir && (
        <div style={{
          padding: '16px',
          background: 'rgba(245, 158, 11, 0.08)',
          borderRadius: '8px',
          border: '1px solid rgba(245, 158, 11, 0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={16} />
            <span>请先配置工作区目录</span>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>工作区目录 (stateDir)</label>
            <PathInput
              value={settings.stateDir}
              onChange={(val) => update({ stateDir: val })}
              placeholder="~/.inkmigrate"
              dialogTitle="选择工作区目录"
            />
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              存放数据库、登录 Profile、报告的目录。
            </div>
          </div>
        </div>
      )}

      <div style={{
        padding: '18px',
        background: 'var(--bg-panel)',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        border: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {displayState === 'success' && <CheckCircle2 size={18} color="var(--success)" />}
          {displayState === 'failed' && <XCircle size={18} color="var(--error)" />}
          {displayState === 'loading' && <Clock size={18} color="var(--warning)" />}
          {displayState === 'idle' && <Clock size={18} color="var(--text-dim)" />}
          <span style={{ fontWeight: 600, fontSize: '14px' }}>{STATUS_TEXT[displayState]}</span>
        </div>

        {profilePath && (
          <div style={{ color: 'var(--text-dim)', fontSize: '12px', wordBreak: 'break-all' }}>
            Profile 凭据路径: <code>{profilePath}</code>
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            onClick={handleLogin}
            disabled={loading || !settings.stateDir}
            className="btn-primary"
            style={{ minWidth: '130px' }}
          >
            <LogIn size={15} />
            <span>{loginLabel}</span>
          </button>

          {!confirmClear ? (
            <button
              onClick={() => setConfirmClear(true)}
              disabled={loading || !settings.loggedIn}
              className="btn-danger"
            >
              <Trash2 size={14} />
              <span>清除登录</span>
            </button>
          ) : (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '2px 8px',
              background: 'rgba(239, 68, 68, 0.12)',
              borderRadius: '6px',
              border: '1px solid rgba(239, 68, 68, 0.25)',
            }}>
              <span style={{ fontSize: '12px', color: 'var(--error)' }}>
                确定清除？需重新扫码
              </span>
              <button
                onClick={handleClear}
                disabled={loading}
                className="btn-danger btn-sm"
              >
                确定
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                disabled={loading}
                className="btn-secondary btn-sm"
              >
                取消
              </button>
            </div>
          )}

          {settings.stateDir && (
            <button
              onClick={() => void refreshLogin()}
              disabled={loading}
              className="btn-secondary"
            >
              <RefreshCw size={14} />
              <span>刷新状态</span>
            </button>
          )}

          {settings.loggedIn && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate('scan')}
              className="btn-secondary"
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <span>前往扫描</span>
              <ArrowRight size={14} />
            </button>
          )}
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-dim)', lineHeight: '1.6' }}>
          💡 点击登录后会自动打开系统浏览器窗口。请在浏览器中扫码完成登录；登录成功后 Profile 会保存在本地，下次使用免登录。
        </div>
      </div>
    </div>
  );
}
