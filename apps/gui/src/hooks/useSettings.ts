import { useState, useEffect } from 'react';
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

/** 设置持久化 hook，存到 localStorage。 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(saved) });
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  const update = (partial: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };

  return { settings, update };
}
