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
          <label htmlFor="settings-stateDir" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>工作区目录 (stateDir)</label>
          <input
            id="settings-stateDir"
            value={settings.stateDir ?? ''}
            onChange={(e) => update({ stateDir: e.target.value })}
            placeholder="~/.inkmigrate"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            存放数据库、Profile、报告的目录
          </div>
        </div>

        <div>
          <label htmlFor="settings-vaultPath" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>Obsidian Vault 路径</label>
          <input
            id="settings-vaultPath"
            value={settings.vaultPath ?? ''}
            onChange={(e) => update({ vaultPath: e.target.value })}
            placeholder="/Users/you/Documents/Obsidian Vault"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            笔记会写入这个目录
          </div>
        </div>

        <div>
          <label htmlFor="settings-sourceAdapter" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>来源类型</label>
          <select
            id="settings-sourceAdapter"
            value={settings.sourceAdapter ?? 'toutiao'}
            onChange={(e) => {
              const sourceAdapter = e.target.value as SourceAdapterKind;
              // 切回 toutiao 时清掉 evernote 的配置路径：MigratePage 对 truthy
              // configPath 无条件转发，残留值会静默改走 evernote 分派
              update(sourceAdapter === 'toutiao' ? { sourceAdapter, configPath: '' } : { sourceAdapter });
            }}
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
            <label htmlFor="settings-configPath" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>配置文件 (inkmigrate.yaml)</label>
            <input
              id="settings-configPath"
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
          <label htmlFor="settings-source" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>来源实例 ID</label>
          <input
            id="settings-source"
            value={settings.source ?? ''}
            onChange={(e) => update({ source: e.target.value })}
            style={{ width: '200px' }}
          />
        </div>

        <div>
          <label htmlFor="settings-target" style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>目标实例 ID</label>
          <input
            id="settings-target"
            value={settings.target ?? ''}
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
