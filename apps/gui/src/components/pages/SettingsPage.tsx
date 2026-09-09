import type { AppSettings, SourceAdapterKind } from '../../lib/types.js';

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
          <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>来源类型</label>
          <select
            value={settings.sourceAdapter ?? 'toutiao'}
            onChange={(e) => update({ sourceAdapter: e.target.value as SourceAdapterKind })}
            style={{ width: '200px' }}
          >
            <option value="toutiao">今日头条（浏览器收藏）</option>
            <option value="evernote">Evernote / 印象笔记（导出文件）</option>
          </select>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            Evernote 来源无需登录：直接读取 ENEX/HTML 导出文件
          </div>
        </div>

        {settings.sourceAdapter === 'evernote' && (
          <div>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>配置文件 (inkmigrate.yaml)</label>
            <input
              value={settings.configPath ?? ''}
              onChange={(e) => update({ configPath: e.target.value })}
              placeholder="/path/to/inkmigrate.yaml"
            />
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              配置中需包含 adapter: evernote 的来源（inputPaths 指向导出目录），见 README Evernote 章节
            </div>
          </div>
        )}

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
