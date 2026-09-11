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

    // fixture 含 2 article + 1 video；video 被过滤，候选剩 2 条 article
    expect(refs.length).toBe(2);
    expect(refs[0]!.externalId).toBe('7428193012345678901');
    expect(refs[0]!.fingerprint).toMatch(/^sha256:/);
    expect(refs[0]!.contentKind).toBe('article');
    expect(refs.every((r) => r.contentKind === 'article')).toBe(true);
    // scanResult 保留原始扫描发现（含 video），不被过滤影响
    expect(scanResult.uniqueItems).toBe(3);
    expect(scanResult.terminationReason).toContain('no_new_items');

    await session.close();
  });

  it('scans mixed-type favorites (video + micro-post) via selector union, filters video from candidates', async () => {
    // 验证两点：
    //  1. 多类型并集抓取仍有效——同一页面混合视频(.profile-normal-video-card-wrapper)
    //     和微头条(.feed-card-wrapper)，两种外层 class 不同，取第一个选择器会漏掉另一种。
    //     scanResult 应反映页面真实发现（3 条全到）。
    //  2. video 在成为迁移候选前被过滤——video 无正文，迁移只会产出空壳笔记。
    //     refs 不应含 video，只保留文本类。
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

    // 扫描发现：2 个视频 + 1 个微头条（并集抓取不漏类型）
    expect(scanResult.uniqueItems).toBe(3);
    const discoveredHrefs = scanResult.items.map((i) => i.canonicalUrl);
    expect(discoveredHrefs.some((u) => u.includes('/video/'))).toBe(true);
    expect(discoveredHrefs.some((u) => u.includes('/w/'))).toBe(true);

    // 候选 refs：video 被过滤，只剩微头条
    expect(refs.length).toBe(1);
    expect(refs.every((r) => r.contentKind !== 'video')).toBe(true);
    expect(refs[0]!.canonicalUrl).toContain('/w/');

    await session.close();
  });

  it('fails fast on 404 favorites page instead of silently returning 0 items', async () => {
    // 死链/改版迁移的收藏 URL（DEFAULT_FAVORITES_URL 的 /favorites 2026-09 实测
    // 已 404）goto 仍正常完成，若不识别 404 页会走空轮循环"正常"终止——调用方
    // 无法区分「没有收藏」和「URL 已失效」，必须显式报错
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    await page.route('**/favorites', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>404 Not Found</title></head><body>404</body></html>',
      }),
    );

    await expect(
      driveScanFavorites({
        page,
        favoritesUrl: 'https://www.toutiao.com/favorites',
        baseUrl: 'https://www.toutiao.com/',
        sourceInstanceId: 'toutiao-main',
        maxEmptyCycles: 1,
        waitAfterScrollMs: 50,
      }),
    ).rejects.toThrow(/404/);

    await session.close();
  });
});
