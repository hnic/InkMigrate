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
});
