import { useState } from 'react';
import type { AppSettings, SourceAdapterKind } from '../../lib/types.js';
import { PathInput } from '../PathInput.js';
import { Settings, Sliders, RotateCcw } from 'lucide-react';

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
}

export function SettingsPage({ settings, update }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleResetDefaults = () => {
    if (window.confirm('确定要重置所有设置为默认值吗？')) {
      update({
        stateDir: '',
        vaultPath: '',
        favoritesUrl: '',
        source: 'toutiao-main',
        target: 'obsidian-main',
        sourceAdapter: 'toutiao',
        configPath: '',
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Settings size={20} />
          <span>系统设置</span>
        </h2>
        <button
          type="button"
          onClick={handleResetDefaults}
          className="btn-ghost btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <RotateCcw size={13} />
          <span>恢复默认</span>
        </button>
      </div>

      <div style={{ padding: '18px', background: 'var(--bg-panel)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '18px', border: '1px solid var(--border)' }}>
        <div>
          <label htmlFor="settings-sourceAdapter" style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
            知识来源类型
          </label>
          <select
            id="settings-sourceAdapter"
            value={settings.sourceAdapter ?? 'toutiao'}
            onChange={(e) => {
              const sourceAdapter = e.target.value as SourceAdapterKind;
              const source = sourceAdapter === 'evernote' ? 'evernote-archive' : 'toutiao-main';
              update(sourceAdapter === 'toutiao' ? { sourceAdapter, configPath: '', source } : { sourceAdapter, source });
            }}
            style={{ width: '280px' }}
          >
            <option value="toutiao">今日头条（浏览器采集）</option>
            <option value="evernote">Evernote / 印象笔记（导出文件）</option>
          </select>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {settings.sourceAdapter === 'evernote'
              ? 'Evernote / 印象笔记来源无需登录：直接解析本地 ENEX/HTML 文件。'
              : '头条来源需启动浏览器登录会话，自动爬取收藏文章列表。'}
          </div>
        </div>

        <div>
          <label htmlFor="settings-stateDir" style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
            工作区目录 (stateDir)
          </label>
          <PathInput
            id="settings-stateDir"
            value={settings.stateDir ?? ''}
            onChange={(val) => update({ stateDir: val })}
            placeholder="~/.inkmigrate"
            dialogTitle="选择工作区目录"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            存放本地 SQLite 数据库、登录 Profile、导出报告的目录。
          </div>
        </div>

        <div>
          <label htmlFor="settings-vaultPath" style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
            Obsidian Vault 路径
          </label>
          <PathInput
            id="settings-vaultPath"
            value={settings.vaultPath ?? ''}
            onChange={(val) => update({ vaultPath: val })}
            placeholder="/Users/you/Documents/Obsidian Vault"
            dialogTitle="选择 Obsidian Vault 目录"
          />
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            迁移生成的 Markdown 笔记及附件会保存写入此目录。
          </div>
        </div>

        {/* 收藏列表 URL 是 toutiao 源的必需配置；evernote 走 configPath，不需要它 */}
        {settings.sourceAdapter === 'toutiao' && (
          <div>
            <label htmlFor="settings-favoritesUrl" style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
              收藏列表 URL
            </label>
            <textarea
              id="settings-favoritesUrl"
              value={settings.favoritesUrl ?? ''}
              onChange={(e) => update({ favoritesUrl: e.target.value })}
              placeholder="https://www.toutiao.com/c/user/token/...?tab=fav"
              rows={2}
              style={{ fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
            />
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              登录成功后通常会自动获取；若没有，在浏览器打开你的头条收藏页，复制地址栏 URL 到这里。
            </div>
          </div>
        )}

        {settings.sourceAdapter === 'evernote' && (
          <div>
            <label htmlFor="settings-configPath" style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
              配置文件 (inkmigrate.yaml)
            </label>
            <PathInput
              id="settings-configPath"
              value={settings.configPath ?? ''}
              onChange={(val) => update({ configPath: val })}
              placeholder="/path/to/inkmigrate.yaml"
              type="file"
              dialogTitle="选择 inkmigrate.yaml 配置文件"
            />
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
              配置中需包含 adapter: evernote 的来源定义（inputPaths 指向导出目录或 ENEX 文件）。
            </div>
          </div>
        )}

        {/* 高级设置：折叠底层实例 ID，普通用户无需接触 */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => setShowAdvanced((prev) => !prev)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)' }}
          >
            <Sliders size={14} />
            <span>{showAdvanced ? '隐藏高级选项' : '展开高级选项（多实例配置）'}</span>
          </button>

          {showAdvanced && (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', background: 'var(--bg-hover)', borderRadius: '6px' }}>
              <div>
                <label htmlFor="settings-source" style={{ display: 'block', marginBottom: '4px', fontSize: '12px' }}>
                  来源实例 ID (Source Instance ID)
                </label>
                <input
                  id="settings-source"
                  value={settings.source ?? ''}
                  onChange={(e) => update({ source: e.target.value })}
                  style={{ width: '240px' }}
                />
              </div>

              <div>
                <label htmlFor="settings-target" style={{ display: 'block', marginBottom: '4px', fontSize: '12px' }}>
                  目标实例 ID (Target Instance ID)
                </label>
                <input
                  id="settings-target"
                  value={settings.target ?? ''}
                  onChange={(e) => update({ target: e.target.value })}
                  style={{ width: '240px' }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
        所有设置均保存在本地存储，数据安全自主可控。
      </div>
    </div>
  );
}
