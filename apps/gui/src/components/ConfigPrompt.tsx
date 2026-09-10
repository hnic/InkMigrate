import type { AppSettings } from '../lib/types.js';

/** ConfigPrompt 可检查/填写的字段集合（供 required 与查表共用，防拼写漂移）。 */
type ConfigField = 'stateDir' | 'vaultPath' | 'favoritesUrl';

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
  favoritesUrl: '收藏页 URL',
};

const FIELD_PLACEHOLDERS: Record<ConfigField, string> = {
  stateDir: '~/.inkmigrate',
  vaultPath: '/Users/you/Documents/Obsidian Vault',
  favoritesUrl: 'https://www.toutiao.com/c/user/token/...?tab=fav',
};

const FIELD_HINTS: Record<ConfigField, string> = {
  stateDir: '存放数据库、登录 Profile、报告的目录',
  vaultPath: '笔记会写入这个目录',
  favoritesUrl: '登录后在浏览器打开你的收藏页，复制地址栏 URL',
};

/**
 * 配置缺失提示框：当必需字段为空时显示输入框让用户原地填写。
 */
export function ConfigPrompt({ settings, update, required, message }: Props) {
  // trim 判空：纯空白的路径/URL 不算已配置，否则提示框消失而下游操作失败
  const missing = required.filter((field) => !settings[field]?.trim());
  if (missing.length === 0) return null;

  return (
    <div style={{
      padding: '16px',
      background: 'rgba(243, 156, 18, 0.1)',
      borderRadius: '8px',
      border: '1px solid rgba(243, 156, 18, 0.3)',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
    }}>
      <div style={{ fontWeight: 600 }}>
        {message ?? `⚠️ 请先填写以下配置`}
      </div>
      {missing.map((field) => (
        <div key={field}>
          <label htmlFor={`config-${field}`} style={{ display: 'block', marginBottom: '4px', fontSize: '13px' }}>
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
            <input
              id={`config-${field}`}
              value={settings[field] ?? ''}
              onChange={(e) => update({ [field]: e.target.value })}
              placeholder={FIELD_PLACEHOLDERS[field]}
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
