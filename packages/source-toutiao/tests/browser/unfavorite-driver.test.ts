import { describe, it, expect } from 'vitest';
import { ToutiaoBrowserSession } from '../../src/browser/browser-session.js';
import { driveUnfavorite } from '../../src/browser/unfavorite-driver.js';
import { createTempProfileDir } from './helpers.js';
import type { SourceItemRef } from '@inkmigrate/core';

const DETAIL_URL = 'https://www.toutiao.com/article/123/';

function makeRef(): SourceItemRef {
  return {
    sourceInstanceId: 'toutiao-test',
    canonicalUrl: DETAIL_URL,
    originalUrl: DETAIL_URL,
    contentKind: 'article',
    discoveredAt: '2026-06-01T00:00:00Z',
    fingerprint: 'sha256:abc',
    sourceMetadata: {},
  };
}

/**
 * 构造带点击交互的详情页 HTML。
 * - initialPressed: 初始 aria-pressed（'true' 已收藏 / 'false' 未收藏）
 * - on_click: 点击后行为
 *     'unfavorite' → 转 false（取消成功）
 *     'noop'       → 保持不变（点击无效，模拟风控/失败）
 */
function detailHtml(
  initialPressed: 'true' | 'false',
  onClick: 'unfavorite' | 'noop',
): string {
  return `<!doctype html><html><body>
<div data-testid="article-detail">
  <h1>文章</h1>
  <button class="favorite-btn" data-testid="favorite-button"
          aria-pressed="${initialPressed}" aria-label="收藏">按钮</button>
</div>
<script>
  document.querySelector('[data-testid="favorite-button"]').addEventListener('click', function () {
    ${onClick === 'unfavorite' ? 'this.setAttribute("aria-pressed", "false");' : '/* noop：模拟风控拦截 */'}
  });
</script>
</body></html>`;
}

/** 空页面（按钮永不渲染），用于测试 not found / 未知。 */
const EMPTY_HTML = '<!doctype html><html><body><h1>无收藏按钮的页面</h1></body></html>';

/**
 * 延迟渲染收藏按钮的页面：模拟 SPA。goto 返回 domcontentloaded 后，按钮在
 * 300ms 后才由 JS 插入 DOM——这正是生产中"未知 1569"的根因（旧逻辑瞬时 count 为 0）。
 */
const SPA_DELAYED_HTML = `<!doctype html><html><body>
<h1>文章</h1>
<script>
  setTimeout(function () {
    var b = document.createElement('button');
    b.className = 'favorite-btn';
    b.setAttribute('data-testid', 'favorite-button');
    b.setAttribute('aria-pressed', 'true');
    b.setAttribute('aria-label', '取消收藏');
    b.textContent = '已收藏';
    document.body.appendChild(b);
  }, 300);
</script>
</body></html>`;

describe('driveUnfavorite', () => {
  it('成功取消收藏：已收藏 → 点击 → 转 not-favorited', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: detailHtml('true', 'unfavorite') }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), waitAfterClickMs: 2000, readingSimulation: 'none' });

    expect(result.wasCollected).toBe(true);
    expect(result.success).toBe(true);
    expect(result.isCollected).toBe(false);

    await session.close();
  });

  it('still collected：已收藏 → 点击无效（风控）→ 失败', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: detailHtml('true', 'noop') }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), waitAfterClickMs: 1500, readingSimulation: 'none' });

    expect(result.wasCollected).toBe(true);
    expect(result.success).toBe(false);
    expect(result.isCollected).toBe(true);
    expect(result.reason).toBe('still collected after click');

    await session.close();
  });

  it('跳过：本来就未收藏（wasCollected=false）', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: detailHtml('false', 'noop') }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), readingSimulation: 'none' });

    expect(result.wasCollected).toBe(false);
    expect(result.success).toBe(true);
    expect(result.isCollected).toBe(false);
    expect(result.reason).toBeUndefined();

    await session.close();
  });

  it('未知：收藏按钮不存在 → not found', async () => {
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: EMPTY_HTML }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), navigationTimeoutMs: 1500, readingSimulation: 'none' });

    expect(result.success).toBe(false);
    expect(result.wasCollected).toBe(false);
    expect(result.reason).toBe('collect button not found');

    await session.close();
  });

  it('SPA 渲染延迟回归：按钮延迟出现，waitFor 等到后正常判定（不再误判未知）', async () => {
    // 这是生产"未知 1569"的根因回归：domcontentloaded 时按钮未渲染，
    // 旧逻辑瞬时 count()=0 → 误判 not found。新逻辑 waitFor(attached) 应等到按钮。
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: SPA_DELAYED_HTML }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), navigationTimeoutMs: 3000, readingSimulation: 'none' });

    // 按钮虽延迟 300ms 渲染，但应被等到 → 不再是 not found
    expect(result.reason).not.toBe('collect button not found');
    expect(result.wasCollected).toBe(true); // 延迟渲染的按钮 aria-pressed=true

    await session.close();
  });

  it('阅读模拟（heavy）：已收藏条目会真实滚动浏览后再点击', async () => {
    // 防风控核心：模拟人类"打开→浏览→读完才取消"。验证页面确实发生滚动（阅读行为指纹）。
    // 用一段足够长的正文撑高页面，让 simulateReading 有内容可滚动。
    const longContent = Array.from({ length: 40 }, (_, i) => `<p>第${i + 1}段正文内容，用于撑高页面让滚动生效。</p>`).join('');
    const html = `<!doctype html><html><body>
<div data-testid="article-detail">
  <h1>长文章</h1>
  ${longContent}
  <button class="favorite-btn" data-testid="favorite-button" aria-pressed="true" aria-label="取消收藏">已收藏</button>
</div>
<script>
  // 记录最大滚动位置，用于断言阅读模拟确实滚动了页面（而非静止）
  window.__maxScrollY = 0;
  window.addEventListener('scroll', () => {
    if (window.scrollY > window.__maxScrollY) window.__maxScrollY = window.scrollY;
  }, { passive: true });
  document.querySelector('[data-testid="favorite-button"]').addEventListener('click', function () {
    this.setAttribute('aria-pressed', 'false');
  });
</script>
</body></html>`;

    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );

    const result = await driveUnfavorite({
      page,
      ref: makeRef(),
      waitAfterClickMs: 2000,
      // 默认 readingSimulation='heavy'，应触发阅读模拟。
      // 注入确定性 RNG（恒返回 0.5）：让停留时长/滚动段数/鼠标轨迹可复现，
      // 既验证 rng 注入生效，又消除 Math.random 导致的测试时长抖动（M7）。
      rng: () => 0.5,
    });

    // heavy 模式应让页面滚动到正文深处（__maxScrollY 显著 > 0），证明发生了浏览行为
    const maxScrollY = await page.evaluate(() => (window as unknown as { __maxScrollY: number }).__maxScrollY);
    expect(maxScrollY).toBeGreaterThan(100);
    // 模拟阅读后点击取消成功
    expect(result.wasCollected).toBe(true);
    expect(result.success).toBe(true);

    await session.close();
  }, 60000); // heavy 阅读有多次随机停留，给足超时

  it('§5 风控验证页（security-challenge）：检测到 challenge_required，不点击直接返回', async () => {
    const challengeHtml = `<!doctype html><html><body>
<div data-testid="security-challenge"><h1>安全验证</h1><p>请完成滑块验证</p></div>
</body></html>`;
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: challengeHtml }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), readingSimulation: 'none' });

    // §5 命中风控验证页 → success=false + detectedState=challenge_required（不点击）
    expect(result.success).toBe(false);
    expect(result.detectedState).toBe('challenge_required');
    expect(result.reason).toBe('challenge_required');

    await session.close();
  });

  it('§5 登录墙重定向：检测到 login_required', async () => {
    // 模拟被重定向到登录页（URL 含 login）
    const LOGIN_URL = 'https://www.toutiao.com/passport/login';
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    // DETAIL_URL 重定向到 LOGIN_URL
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ status: 302, headers: { location: LOGIN_URL } }),
    );
    await page.route(LOGIN_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>登录</h1></body></html>' }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), readingSimulation: 'none' });

    expect(result.success).toBe(false);
    expect(result.detectedState).toBe('login_required');
    expect(result.reason).toBe('login_required');

    await session.close();
  });

  it('§5 内容已删除（content-deleted）：检测到 content_unavailable', async () => {
    const deletedHtml = `<!doctype html><html><body>
<div data-testid="content-deleted"><p>该内容已被删除</p></div>
</body></html>`;
    const profileDir = createTempProfileDir();
    const session = new ToutiaoBrowserSession({ profileDir, headless: true });
    await session.launch();
    const page = await session.newPage();
    await page.route(DETAIL_URL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: deletedHtml }),
    );

    const result = await driveUnfavorite({ page, ref: makeRef(), readingSimulation: 'none' });

    expect(result.success).toBe(false);
    expect(result.detectedState).toBe('content_unavailable');
    expect(result.reason).toBe('content_unavailable');

    await session.close();
  });
});
