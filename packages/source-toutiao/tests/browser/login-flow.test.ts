import { describe, it, expect } from 'vitest';
import { ToutiaoBrowserSession } from '../../src/browser/browser-session.js';
import { runLoginFlow } from '../../src/browser/login-flow.js';
import { createTempProfileDir } from './helpers.js';
import { loadFixture } from '../helpers/fixtures.js';

describe('runLoginFlow', () => {
  it('detects logged-in state from favorites page with user-center element', async () => {
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

    const result = await runLoginFlow({
      session,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      loginTimeoutMs: 5000,
      page,
    });

    // favorites-list.html has [data-testid="user-center"] + .username
    // → hasUserEntryElement=true, favoritesPageAccessible=true, no login mask
    // → at least 2 positive signals, 0 negative → logged-in
    expect(result.state).toBe('logged-in');
    expect(result.signals.hasUserEntryElement).toBe(true);

    await session.close();
  });

  it('detects not-logged-in state from login-required page', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    const loginHtml = loadFixture('login-required');
    await page.route('**/favorites', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: loginHtml,
      }),
    );

    const result = await runLoginFlow({
      session,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      loginTimeoutMs: 1000,
      page,
    });

    // login-required.html has [data-testid="login-required"] + .login-mask
    // → hasLoginMask=true (negative signal), hasUserEntryElement=undefined
    // → negatives > 0, so state should not be logged-in
    expect(result.state).not.toBe('logged-in');

    await session.close();
  });
});
