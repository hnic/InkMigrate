import { describe, it, expect } from 'vitest';
import { createToutiaoSource } from '../../src/adapters/adapter.js';
import { ToutiaoBrowserSession, driveScanFavorites, driveExtractDetail } from '../../src/browser/index.js';
import { createTempProfileDir } from './helpers.js';
import { loadFixture } from '../helpers/fixtures.js';

/**
 * E2E smoke test: validates the full data flow via Playwright route interception,
 * without needing a real Toutiao account.
 *
 * Route interception maps favorites and article URLs to fixture HTML.
 *
 * Real-account E2E is a pre-release manual gate (section 24.6), not run in CI.
 */
describe('E2E: adapter lifecycle and scan/extract data flow', () => {
  it('adapter prepare → scan (empty) → close lifecycle', async () => {
    // 验证 adapter lifecycle：构造 → prepare（启动浏览器）→ close。
    // 由于 adapter 内部创建 page 且不暴露，scan 会尝试访问真实 URL。
    // 这里只验证 lifecycle 不抛异常。
    const profileDir = createTempProfileDir();
    const adapter = createToutiaoSource({
      sourceInstanceId: 'toutiao-main',
      profileDir,
      headless: true,
      scanMaxEmptyCycles: 1,
      scanWaitAfterScrollMs: 50,
    });

    await adapter.prepare({ config: {}, workspaceDir: '.' });
    expect(adapter.kind).toBe('toutiao');
    expect(adapter.capabilities.authMode).toBe('browser-profile');
    await adapter.close();
  });

  it('full scan → extract with session + drivers via route interception', async () => {
    // 直接使用 session + drivers，验证完整的数据流。
    // 不通过 adapter（adapter 不暴露 page 用于路由拦截）。
    const profileDir = createTempProfileDir();
    const favoritesHtml = loadFixture('favorites-list');
    const articleHtml = loadFixture('article');

    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    // 路由拦截
    await page.route('**/favorites', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: favoritesHtml,
      }),
    );
    await page.route('**/article/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: articleHtml,
      }),
    );

    // scan
    const { refs } = await driveScanFavorites({
      page,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      baseUrl: 'https://www.toutiao.com/',
      sourceInstanceId: 'toutiao-main',
      maxEmptyCycles: 1,
      waitAfterScrollMs: 50,
    });

    expect(refs.length).toBe(3);

    // extract 第一条（article 类型）
    const articleRef = refs.find((r) => r.contentKind === 'article')!;
    expect(articleRef).toBeDefined();

    const item = await driveExtractDetail({ page, ref: articleRef });

    expect(item.quality).toBe('full');
    expect(item.title).toBe('人工智能如何改变软件开发');
    expect(item.bodyText).toBeDefined();
    expect(item.bodyText!.length).toBeGreaterThan(0);
    expect(item.extractionMethod).toBe('browser');
    expect(item.assets.length).toBeGreaterThan(0);

    await session.close();
  });
});
