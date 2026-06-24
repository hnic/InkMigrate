import { describe, it, expect } from 'vitest';
import { ToutiaoBrowserSession } from '../../src/browser/browser-session.js';
import { createTempProfileDir } from './helpers.js';

describe('ToutiaoBrowserSession', () => {
  it('launches, creates pages, and closes', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({
      profileDir,
      headless: true,
    });

    expect(session.launched).toBe(false);

    await session.launch();
    expect(session.launched).toBe(true);

    const page = await session.newPage();
    expect(page).toBeDefined();
    await page.goto('data:text/html,<h1>test</h1>');
    const title = await page.textContent('h1');
    expect(title).toBe('test');

    await session.close();
    expect(session.launched).toBe(false);
  });

  it('close is safe to call when not launched', async () => {
    const session = new ToutiaoBrowserSession({
      profileDir: createTempProfileDir(),
      headless: true,
    });
    await session.close(); // should not throw
    expect(session.launched).toBe(false);
  });

  it('newPage throws when not launched', async () => {
    const session = new ToutiaoBrowserSession({
      profileDir: createTempProfileDir(),
      headless: true,
    });
    await expect(session.newPage()).rejects.toThrow('not launched');
  });
});
