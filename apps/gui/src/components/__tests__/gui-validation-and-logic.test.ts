import { describe, it, expect } from 'vitest';
import { normalizeFavoritesUrl, isSendableFavoritesUrl } from '../../lib/favorites-url.js';
import type { AppSettings } from '../../lib/types.js';

describe('GUI Validation & Logic Tests (避免功能漂移)', () => {
  describe('Evernote vs Toutiao 迁移条件判定解耦测试', () => {
    function computeCanStartMigrate(settings: AppSettings): boolean {
      const isEvernote = settings.sourceAdapter === 'evernote';
      return isEvernote
        ? Boolean(settings.stateDir && settings.vaultPath && settings.configPath)
        : Boolean(settings.stateDir && settings.vaultPath && settings.favoritesUrl && settings.loggedIn);
    }

    it('Evernote 文件源模式下：只要具备工作区、Vault与配置文件，即可启动迁移（无需登录与URL）', () => {
      const evernoteSettings: AppSettings = {
        sourceAdapter: 'evernote',
        stateDir: '/tmp/workspace',
        vaultPath: '/tmp/vault',
        configPath: '/tmp/inkmigrate.yaml',
        favoritesUrl: '', // 空
        loggedIn: false,  // 未登录
        source: 'evernote-archive',
        target: 'obsidian-main',
      };

      expect(computeCanStartMigrate(evernoteSettings)).toBe(true);
    });

    it('Evernote 缺失 configPath 时应被拦截', () => {
      const evernoteSettings: AppSettings = {
        sourceAdapter: 'evernote',
        stateDir: '/tmp/workspace',
        vaultPath: '/tmp/vault',
        configPath: '', // 缺失
        favoritesUrl: '',
        loggedIn: false,
        source: 'evernote-archive',
        target: 'obsidian-main',
      };

      expect(computeCanStartMigrate(evernoteSettings)).toBe(false);
    });

    it('今日头条来源：未登录或缺失收藏 URL 时必须拦截，避免无效请求', () => {
      const toutiaoSettings: AppSettings = {
        sourceAdapter: 'toutiao',
        stateDir: '/tmp/workspace',
        vaultPath: '/tmp/vault',
        favoritesUrl: 'https://www.toutiao.com/c/user/token/test/?tab=fav',
        loggedIn: false, // 未登录
        source: 'toutiao-main',
        target: 'obsidian-main',
      };

      expect(computeCanStartMigrate(toutiaoSettings)).toBe(false);

      // 登录后应允许
      toutiaoSettings.loggedIn = true;
      expect(computeCanStartMigrate(toutiaoSettings)).toBe(true);

      // URL 为空应拦截
      toutiaoSettings.favoritesUrl = '';
      expect(computeCanStartMigrate(toutiaoSettings)).toBe(false);
    });
  });

  describe('favoritesUrl 校验与规范化逻辑', () => {
    it('支持去除首尾空白与噪声字符', () => {
      const raw = '   https://www.toutiao.com/c/user/token/ABC123/?tab=fav   ';
      const clean = normalizeFavoritesUrl(raw);
      expect(clean).toBe('https://www.toutiao.com/c/user/token/ABC123/?tab=fav');
      expect(isSendableFavoritesUrl(clean)).toBe(true);
    });

    it('识别非法协议或纯文本输入', () => {
      expect(isSendableFavoritesUrl('ftp://example.com')).toBe(false);
      expect(isSendableFavoritesUrl('just-a-plain-string')).toBe(false);
      expect(isSendableFavoritesUrl('')).toBe(false);
    });
  });

  describe('ConfigPrompt 缺失字段计算逻辑', () => {
    function getMissingFields(
      settings: Record<string, string | undefined>,
      required: string[]
    ): string[] {
      return required.filter((field) => !settings[field]?.trim());
    }

    it('纯空格字符串不应被误判为已填写', () => {
      const settings = {
        stateDir: '   ',
        vaultPath: '/Users/test/Vault',
      };
      const missing = getMissingFields(settings, ['stateDir', 'vaultPath']);
      expect(missing).toEqual(['stateDir']);
    });

    it('所有必填项已正确填入时返回空数组', () => {
      const settings = {
        stateDir: '~/.inkmigrate',
        vaultPath: '/Users/test/Vault',
        configPath: 'inkmigrate.yaml',
      };
      const missing = getMissingFields(settings, ['stateDir', 'vaultPath', 'configPath']);
      expect(missing).toHaveLength(0);
    });
  });

  describe('历史任务排序与上限截断逻辑', () => {
    function addRecentJob(existing: string[], newJobId: string, limit = 8): string[] {
      return [newJobId, ...existing.filter((id) => id !== newJobId)].slice(0, limit);
    }

    it('新 Job 插入在最前面，且去重不重复', () => {
      const list = ['mig-1', 'mig-2', 'mig-3'];
      const updated = addRecentJob(list, 'mig-2');
      expect(updated).toEqual(['mig-2', 'mig-1', 'mig-3']);
    });

    it('超过上限时丢弃最旧的记录', () => {
      const list = ['1', '2', '3', '4', '5'];
      const updated = addRecentJob(list, 'new', 4);
      expect(updated).toEqual(['new', '1', '2', '3']);
    });
  });
});
