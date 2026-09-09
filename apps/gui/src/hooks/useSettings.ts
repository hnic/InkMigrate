import { useState, useEffect, useCallback } from 'react';
import type { AppSettings } from '../lib/types.js';

const STORAGE_KEY = 'inkmigrate-settings';

const DEFAULT_SETTINGS: AppSettings = {
  stateDir: '',
  vaultPath: '',
  favoritesUrl: '',
  source: 'toutiao-main',
  target: 'obsidian-main',
  sourceAdapter: 'toutiao',
  configPath: '',
};

/** 读取 localStorage 中已保存的设置；逐字段校验类型，损坏/结构异常的数据直接丢弃。 */
function loadSavedSettings(): Partial<AppSettings> {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return {};
    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const result: Partial<AppSettings> = {};
    for (const key of ['stateDir', 'vaultPath', 'favoritesUrl', 'source', 'target', 'configPath'] as const) {
      if (typeof record[key] === 'string') result[key] = record[key] as string;
    }
    if (typeof record.loggedIn === 'boolean') result.loggedIn = record.loggedIn;
    if (record.sourceAdapter === 'toutiao' || record.sourceAdapter === 'evernote') {
      result.sourceAdapter = record.sourceAdapter;
    }
    return result;
  } catch {
    // 解析失败按无保存数据处理，回退默认设置
    return {};
  }
}

/** 设置持久化 hook，存到 localStorage。 */
export function useSettings() {
  // 惰性初始化：首帧即读到已保存设置，避免先渲染默认值再被加载效果覆盖
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...loadSavedSettings(),
  }));

  // 持久化放在副作用里，保持 setState updater 纯净
  // （StrictMode/并发渲染下 updater 可能被多次调用或被丢弃）
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // ignore quota errors
    }
  }, [settings]);

  const update = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  return { settings, update };
}
