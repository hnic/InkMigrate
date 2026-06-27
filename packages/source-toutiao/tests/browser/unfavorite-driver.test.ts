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

    const result = await driveUnfavorite({ page, ref: makeRef(), waitAfterClickMs: 2000 });

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

    const result = await driveUnfavorite({ page, ref: makeRef(), waitAfterClickMs: 1500 });

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

    const result = await driveUnfavorite({ page, ref: makeRef() });

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

    const result = await driveUnfavorite({ page, ref: makeRef(), navigationTimeoutMs: 1500 });

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

    const result = await driveUnfavorite({ page, ref: makeRef(), navigationTimeoutMs: 3000 });

    // 按钮虽延迟 300ms 渲染，但应被等到 → 不再是 not found
    expect(result.reason).not.toBe('collect button not found');
    expect(result.wasCollected).toBe(true); // 延迟渲染的按钮 aria-pressed=true

    await session.close();
  });
});
