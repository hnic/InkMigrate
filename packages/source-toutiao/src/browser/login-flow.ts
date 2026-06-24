import type { Page } from 'playwright';
import type { ToutiaoBrowserSession } from './browser-session.js';
import {
  detectLoginState,
  type LoginSignals,
  type LoginState,
} from '../auth/login-detector.js';

/** §12.2 登录/收藏页面 URL 中包含这些片段时判定为认证页面。 */
const AUTH_URL_PATTERNS = ['login', 'passport', 'sso', 'account'];

export interface LoginFlowOptions {
  session: ToutiaoBrowserSession;
  /** 收藏列表 URL。未登录时通常重定向到登录页。 */
  favoritesUrl: string;
  /** 等待用户手动登录的超时毫秒数。默认 300000（5 分钟）。 */
  loginTimeoutMs?: number;
  /** 轮询登录状态的间隔毫秒。默认 2000。 */
  pollIntervalMs?: number;
  /**
   * 可选的预配置 Page（例如测试中设置了 route 拦截）。
   * 不传时自动通过 session.newPage() 创建。
   */
  page?: Page;
}

export interface LoginFlowResult {
  state: LoginState;
  signals: Partial<LoginSignals>;
}

/**
 * §12.2 浏览器登录引导流程。
 *
 * 流程：
 * 1. 导航到 favoritesUrl（收藏页）。已登录则直接打开；未登录则重定向到登录页。
 * 2. 收集登录信号，用 detectLoginState 判断。
 * 3. 如果未登录或状态不确定：
 *    a. 提示用户在可见浏览器中完成登录（扫码/验证码）。
 *    b. 轮询页面状态，直到 logged-in 或超时。
 * 4. Profile 由 launchPersistentContext 自动持久化，无需额外保存 Cookie。
 *
 * §12.2 安全要求：
 * - 不猜测已登录（至少 2 个独立正向信号 + 0 反向信号）。
 * - 不要求密码、Cookie、Token。
 * - 不使用验证码破解、stealth、坐标点击。
 */
export async function runLoginFlow(opts: LoginFlowOptions): Promise<LoginFlowResult> {
  const ownsPage = opts.page === undefined;
  const page = opts.page ?? (await opts.session.newPage());

  const originalUrl = opts.favoritesUrl;
  await page.goto(originalUrl, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  });

  // 第一轮检测
  let signals = await collectLoginSignals(page, originalUrl);
  let state = detectLoginState(signals);

  if (state === 'logged-in') {
    if (ownsPage) await page.close();
    return { state, signals };
  }

  // 未登录或状态不确定 → 等待用户手动登录
  const timeoutMs = opts.loginTimeoutMs ?? 300_000;
  const pollMs = opts.pollIntervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const currentUrl = page.url();
    if (currentUrl !== 'about:blank') {
      // 检查是否已离开登录页（用户完成登录后通常重定向回原页面）
      const leftAuth = !AUTH_URL_PATTERNS.some((p) => currentUrl.toLowerCase().includes(p));
      if (leftAuth) {
        // 可能已登录，重新检测
        signals = await collectLoginSignals(page, originalUrl);
        state = detectLoginState(signals);
        if (state === 'logged-in') {
          if (ownsPage) await page.close();
          return { state, signals };
        }
      }
    }
  }

  // 超时：返回最终状态
  signals = await collectLoginSignals(page, originalUrl);
  state = detectLoginState(signals);
  if (ownsPage) await page.close();
  return { state, signals };
}

/**
 * 从 Playwright 页面收集 §12.2 登录检测信号。
 */
async function collectLoginSignals(
  page: Page,
  originalUrl: string,
): Promise<Partial<LoginSignals>> {
  const currentUrl = page.url();
  const urlLower = currentUrl.toLowerCase();

  const signals: Partial<LoginSignals> = {
    currentUrlLeftAuthPage: !AUTH_URL_PATTERNS.some((p) => urlLower.includes(p)),
    redirectedToLogin: AUTH_URL_PATTERNS.some((p) => urlLower.includes(p)),
  };

  // hasUserEntryElement: 检查已登录用户入口（用 count 检查元素存在，不依赖 CSS 可见性时序）
  const userEntrySelectors = [
    '[data-testid="user-center"]',
    '.username',
    '.user-avatar',
    '.account-menu',
    '[data-testid="user-avatar"]',
  ];
  for (const sel of userEntrySelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      signals.hasUserEntryElement = true;
      break;
    }
  }

  // hasLoginMask: 检查登录遮罩
  const loginMaskSelectors = [
    '[data-testid="login-required"]',
    '.login-mask',
    '.login-dialog',
    '[data-testid="login-mask"]',
  ];
  for (const sel of loginMaskSelectors) {
    const count = await page.locator(sel).count().catch(() => 0);
    if (count > 0) {
      signals.hasLoginMask = true;
      break;
    }
  }

  // favoritesPageAccessible: 导航目标 URL 与当前 URL 一致（未被重定向到登录页）
  try {
    const originalPath = new URL(originalUrl).pathname;
    const currentPath = new URL(currentUrl).pathname;
    signals.favoritesPageAccessible = originalPath === currentPath && !signals.hasLoginMask;
  } catch {
    // URL 解析失败，不设置该信号
  }

  // cookieExists: 检查常见认证 Cookie（仅辅助信号）
  const cookies = await page.context().cookies();
  const hasSessionCookie = cookies.some(
    (c) => c.name.includes('session') || c.name.includes('token') || c.name.includes('sid'),
  );
  if (hasSessionCookie) {
    signals.cookieExists = true;
  }

  return signals;
}
