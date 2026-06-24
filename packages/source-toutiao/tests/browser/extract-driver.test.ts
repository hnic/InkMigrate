import { describe, it, expect } from 'vitest';
import { ToutiaoBrowserSession } from '../../src/browser/browser-session.js';
import { driveExtractDetail } from '../../src/browser/extract-driver.js';
import { createTempProfileDir } from './helpers.js';
import { loadFixture } from '../helpers/fixtures.js';
import type { SourceItemRef } from '@inkmigrate/core';

describe('driveExtractDetail', () => {
  it('extracts article detail via route interception', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    const articleHtml = loadFixture('article');
    const articleUrl = 'https://www.toutiao.com/article/7428193012345678901/';
    await page.route('**/article/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: articleHtml,
      }),
    );

    const ref: SourceItemRef = {
      sourceInstanceId: 'toutiao-main',
      externalId: '7428193012345678901',
      canonicalUrl: articleUrl,
      originalUrl: articleUrl,
      title: 'test',
      contentKind: 'article',
      discoveredAt: '2026-06-24T10:00:00+08:00',
      fingerprint: 'sha256:' + 'a'.repeat(64),
      sourceMetadata: {},
    };

    const item = await driveExtractDetail({ page, ref });

    expect(item.quality).toBe('full');
    expect(item.title).toBe('人工智能如何改变软件开发');
    expect(item.bodyText).toBeDefined();
    expect(item.bodyText!.length).toBeGreaterThan(0);
    expect(item.extractionMethod).toBe('browser');

    await session.close();
  });

  it('returns degraded quality for deleted content', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    const deletedHtml = loadFixture('deleted');
    await page.route('**/article/**', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: deletedHtml,
      }),
    );

    const ref: SourceItemRef = {
      sourceInstanceId: 'toutiao-main',
      canonicalUrl: 'https://www.toutiao.com/article/999/',
      contentKind: 'article',
      discoveredAt: '2026-06-24T10:00:00+08:00',
      fingerprint: 'sha256:' + 'b'.repeat(64),
      sourceMetadata: {},
    };

    const item = await driveExtractDetail({ page, ref });

    expect(item.quality).toBe('degraded');
    expect(item.degradations.some((d) => d.code === 'content-unavailable')).toBe(true);

    await session.close();
  });
});
