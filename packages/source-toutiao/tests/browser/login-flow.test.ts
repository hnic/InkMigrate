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

  it('detects logged-in via aria-label header (2026 改版后真实结构)', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    // header-logged-in.html 是头条改版后的真实 header：
    //   .ttp-header-profile .user-icon a[aria-label="用户名"] img
    // 没有 .name 元素，没有 .login-button
    const headerHtml = loadFixture('header-logged-in');
    await page.route('**/favorites', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: headerHtml }),
    );

    const start = Date.now();
    const result = await runLoginFlow({
      session,
      favoritesUrl: 'https://www.toutiao.com/favorites',
      loginTimeoutMs: 30_000,
      page,
    });

    expect(result.state).toBe('logged-in');
    // 关键：必须走主检测路径（即时命中），而非等到超时兜底
    // 若走了超时，这里会耗时 ~30s；主检测命中应在数秒内
    expect(Date.now() - start).toBeLessThan(20_000);

    await session.close();
  });

  it('detects logged-in on 2026-09 home DOM (.fix-header + .user-icon, 用户名在 img[alt]/span)', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    // header-logged-in-2026-09.html 是 2026-09 实测首页结构（探针采集）：
    //   .fix-header > .user-icon > a > img[alt="用户名"]（无 aria-label、无 header 元素）
    //   .user-list 下拉里的「我的收藏」链接（协议相对 //...?tab=fav...）无需 hover 即在 DOM
    const homeHtml = loadFixture('header-logged-in-2026-09');
    await page.route('**/home2026', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: homeHtml }),
    );

    const start = Date.now();
    const result = await runLoginFlow({
      session,
      // 指向被拦截的伪首页 URL：验证「无保存 favoritesUrl 时按首页检测」的选择器
      // 集合（favoritesUrl 在此处仅充当导航目标，提取仍走页内 tab=fav 链接）
      favoritesUrl: 'https://www.toutiao.com/home2026',
      loginTimeoutMs: 30_000,
      pollIntervalMs: 1000,
      page,
    });

    // 等待期不应干等满超时：首页选择器或周期性多信号检测应在数秒内命中
    expect(result.state).toBe('logged-in');
    expect(Date.now() - start).toBeLessThan(20_000);
    // 「我的收藏」链接应被提取并解析为绝对 https URL（协议相对 → https），且
    // 畸形 query 需规范化：2026-09 实测页头 href 是 ?tab=fav?source=feed（& 写成了
    // ?），整页导航时 tab 值变成 'fav?source=feed' 不被识别、收藏页落在默认 tab
    // 扫出 0 条（2026-09-11 实测）；规范化为 & 后同一 Profile 实测可见收藏条目
    expect(result.favoritesUrl).toBe(
      'https://www.toutiao.com/c/user/token/MOCK_TOKEN_2026_09/?tab=fav&source=feed',
    );

    await session.close();
  });

  it('ends the wait early via periodic multi-signal check when DOM fast-path selectors all miss', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();

    // home-signals-only.html：DOM 快路径（header/头像/aria-label/登录按钮）全部
    // 失配，仅 .username 命中 collectLoginSignals 的 userEntrySelectors。
    // 已登录用户面对选择器漂移时不应干等满 loginTimeoutMs——轮询内周期性
    // 多信号交叉校验（与超时出口同一判据）应提前收敛为 logged-in。
    const html = loadFixture('home-signals-only');
    await page.route('**/signals-only', (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );

    const start = Date.now();
    const result = await runLoginFlow({
      session,
      favoritesUrl: 'https://www.toutiao.com/signals-only',
      loginTimeoutMs: 20_000,
      pollIntervalMs: 500,
      page,
    });

    expect(result.state).toBe('logged-in');
    // 首轮渲染等待最多 5s（两选择器均失配时白等）+ 首轮信号核查 + 提取轮询 ≪ 20s
    // 超时；若退化为干等超时（回归），耗时 ≥20s，本断言失败
    expect(Date.now() - start).toBeLessThan(15_000);

    await session.close();
  });
});
