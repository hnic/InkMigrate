import type { AppSettings, ConfigField } from '../lib/types.js';
import { getMissingConfigFields } from '../lib/gui-helpers.js';
import { PathInput } from './PathInput.js';
import { AlertTriangle } from 'lucide-react';

export type { ConfigField };

interface Props {
  settings: AppSettings;
  update: (partial: Partial<AppSettings>) => void;
  /** 检查哪些字段缺失，只显示缺失的输入框。 */
  required: ConfigField[];
  /** 提示文案。 */
  message?: string;
}

const FIELD_LABELS: Record<ConfigField, string> = {
  stateDir: '工作区目录 (stateDir)',
  vaultPath: 'Obsidian Vault 路径',
  favoritesUrl: '收藏列表 URL',
  configPath: '配置文件 (inkmigrate.yaml) 路径',
};

const FIELD_PLACEHOLDERS: Record<ConfigField, string> = {
  stateDir: '~/.inkmigrate',
  vaultPath: '/Users/you/Documents/Obsidian Vault',
  favoritesUrl: 'https://www.toutiao.com/c/user/token/...?tab=fav',
  configPath: '/path/to/inkmigrate.yaml',
};

const FIELD_HINTS: Record<ConfigField, string> = {
  stateDir: '存放数据库、登录 Profile、报告的目录',
  vaultPath: '笔记会写入这个目录',
  favoritesUrl: '登录后在浏览器打开你的收藏页，复制地址栏 URL',
  configPath: 'Evernote 来源配置，包含导出文件与笔记映射定义',
};

/**
 * 配置缺失提示框：当必需字段为空时显示输入框让用户原地填写。
 */
export function ConfigPrompt({ settings, update, required, message }: Props) {
  // trim 判空：由 gui-helpers 统一判定，纯空白的路径/URL 不算已配置
  const missing = getMissingConfigFields(settings, required);
  if (missing.length === 0) return null;

  return (
    <div style={{
      padding: '16px',
      background: 'rgba(245, 158, 11, 0.08)',
      borderRadius: '8px',
      border: '1px solid rgba(245, 158, 11, 0.25)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--warning)' }}>
        <AlertTriangle size={18} />
        <span>{message ?? '请先填写以下配置'}</span>
      </div>
      {missing.map((field) => (
        <div key={field}>
          <label htmlFor={`config-${field}`} style={{ display: 'block', marginBottom: '6px', fontSize: '13px', fontWeight: 500 }}>
            {FIELD_LABELS[field]}
          </label>
          {field === 'favoritesUrl' ? (
            <textarea
              id={`config-${field}`}
              value={settings[field] ?? ''}
              onChange={(e) => update({ [field]: e.target.value })}
              placeholder={FIELD_PLACEHOLDERS[field]}
              rows={2}
              style={{ fontFamily: 'monospace', fontSize: '12px', resize: 'vertical' }}
            />
          ) : (
            <PathInput
              id={`config-${field}`}
              value={settings[field] ?? ''}
              onChange={(val) => update({ [field]: val })}
              placeholder={FIELD_PLACEHOLDERS[field]}
              type={field === 'configPath' ? 'file' : 'directory'}
              dialogTitle={`选择 ${FIELD_LABELS[field]}`}
            />
          )}
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: '4px' }}>
            {FIELD_HINTS[field]}
          </div>
        </div>
      ))}
    </div>
  );
}
