import type { AppSettings } from '../../lib/types.js';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
}

export function SettingsPage({ settings, update }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '18px' }}>设置</h2>

      <div style={{ padding: '16px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>工作区目录 (stateDir)</label>
          <input
            value={settings.stateDir}
            onChange={(e) => update({ stateDir: e.target.value })}
            placeholder="~/.inkmigrate"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            存放数据库、Profile、报告的目录
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>Obsidian Vault 路径</label>
          <input
            value={settings.vaultPath}
            onChange={(e) => update({ vaultPath: e.target.value })}
            placeholder="/Users/you/Documents/Obsidian Vault"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            笔记会写入这个目录
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>收藏页 URL</label>
          <textarea
            value={settings.favoritesUrl}
            onChange={(e) => update({ favoritesUrl: e.target.value })}
            placeholder="登录后自动获取"
            rows={3}
            style={{ fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            💡 登录时自动获取，通常无需手动修改。仅当 URL 过期失效时才需要更新。
          </div>
        </div>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>来源实例 ID</label>
          <input
            value={settings.source}
            onChange={(e) => update({ source: e.target.value })}
            style={{ width: '200px' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>目标实例 ID</label>
          <input
            value={settings.target}
            onChange={(e) => update({ target: e.target.value })}
            style={{ width: '200px' }}
          />
        </div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
        设置自动保存到浏览器 localStorage。
      </div>
    </div>
  );
}
