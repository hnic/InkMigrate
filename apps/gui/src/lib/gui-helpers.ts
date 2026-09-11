import type { AppSettings, ConfigField, SourceAdapterKind } from './types.js';

/**
 * 判定当前配置是否满足启动/续跑迁移的最低要求。
 * - Evernote: 需要 stateDir, vaultPath, configPath（无需登录和头条收藏 URL）
 * - 今日头条: 需要 stateDir, vaultPath, favoritesUrl, loggedIn
 */
export function computeCanStartMigrate(settings: AppSettings): boolean {
  const isEvernote = settings.sourceAdapter === 'evernote';
  return isEvernote
    ? Boolean(settings.stateDir?.trim() && settings.vaultPath?.trim() && settings.configPath?.trim())
    : Boolean(settings.stateDir?.trim() && settings.vaultPath?.trim() && settings.favoritesUrl?.trim() && settings.loggedIn);
}

/**
 * 获取迁移前必须填写的核心配置字段。
 */
export function getRequiredMigrateFields(sourceAdapter?: SourceAdapterKind): ConfigField[] {
  return sourceAdapter === 'evernote'
    ? ['stateDir', 'vaultPath', 'configPath']
    : ['stateDir', 'vaultPath', 'favoritesUrl'];
}

/**
 * 检查必填字段中哪些尚未配置（去除纯空白字符串）。
 */
export function getMissingConfigFields(
  settings: Partial<AppSettings>,
  required: ConfigField[]
): ConfigField[] {
  return required.filter((field) => !settings[field]?.trim());
}

/**
 * 来源切换时的配置状态变更 Patch（单一事实来源，消除 App.tsx 与 SettingsPage.tsx 的重复定义）。
 */
export function getSourceSwitchPatch(adapter: SourceAdapterKind): Partial<AppSettings> {
  const source = adapter === 'evernote' ? 'evernote-archive' : 'toutiao-main';
  return adapter === 'toutiao'
    ? { sourceAdapter: adapter, configPath: '', source }
    : { sourceAdapter: adapter, source };
}

/**
 * 历史任务队列插入与截断（FIFO，新 Job 置顶，去重，限制最多 N 条）。
 */
export function addRecentJob(existing: string[], newJobId: string, limit = 8): string[] {
  return [newJobId, ...existing.filter((id) => id !== newJobId)].slice(0, limit);
}

/**
 * 对 Job ID 做安全过滤，仅保留字母、数字、下划线与短横线，防止路径穿越（../）。
 */
export function sanitizeJobId(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '');
}
