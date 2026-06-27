import { describe, it, expect } from 'vitest';
import { ToutiaoBrowserSession } from '../../src/browser/browser-session.js';
import { driveScanFavorites } from '../../src/browser/scan-driver.js';
import { createTempProfileDir } from './helpers.js';
import { loadFixture } from '../helpers/fixtures.js';

describe('driveScanFavorites', () => {
  it('scans favorites list via route interception', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    const favoritesHtml = loadFixture('favorites-list');
    await page.route('**/favorites', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: favoritesHtml,
      }),
    );

    const { refs, scanResult } = await driveScanFavorites({
      page,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      baseUrl: 'https://www.toutiao.com/',
      sourceInstanceId: 'toutiao-main',
      maxEmptyCycles: 1,
      waitAfterScrollMs: 50,
    });

    expect(refs.length).toBe(3);
    expect(refs[0]!.externalId).toBe('7428193012345678901');
    expect(refs[0]!.fingerprint).toMatch(/^sha256:/);
    expect(refs[0]!.contentKind).toBe('article');
    expect(scanResult.uniqueItems).toBe(3);
    expect(scanResult.terminationReason).toContain('no_new_items');

    await session.close();
  });

  it('scans mixed-type favorites (video + micro-post) via selector union', async () => {
    // 验证多类型并集抓取：同一页面混合视频(.profile-normal-video-card-wrapper)
    // 和微头条(.feed-card-wrapper)，两种外层 class 不同。
    // 若 scan-driver 仍"取第一个选择器就 break"，会只抓到一种类型。
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    const favoritesHtml = loadFixture('favorites-mixed');
    await page.route('**/favorites', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: favoritesHtml,
      }),
    );

    const { refs, scanResult } = await driveScanFavorites({
      page,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      baseUrl: 'https://www.toutiao.com/',
      sourceInstanceId: 'toutiao-main',
      maxEmptyCycles: 1,
      waitAfterScrollMs: 50,
    });

    // 必须 3 条全抓到：2 个视频 + 1 个微头条
    expect(refs.length).toBe(3);
    // 两种类型都出现（按 href 前缀区分）
    const hrefs = refs.map((r) => r.canonicalUrl);
    expect(hrefs.some((u) => u.includes('/video/'))).toBe(true);
    expect(hrefs.some((u) => u.includes('/w/'))).toBe(true);
    expect(scanResult.uniqueItems).toBe(3);

    await session.close();
  });
});
