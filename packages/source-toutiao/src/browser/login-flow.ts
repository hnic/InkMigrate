import type { Page } from 'playwright';
import type { ToutiaoBrowserSession } from './browser-session.js';
import {
  detectLoginState,
  type LoginSignals,
  type LoginState,
} from '../auth/login-detector.js';

/** §12.2 登录/收藏页面 URL 中包含这些片段时判定为认证页面。 */
const AUTH_URL_PATTERNS = ['login', 'passport', 'sso', 'account'];

/** §12.2 无 favoritesUrl 时用首页检测登录态。 */
const TOUTIAO_HOME = 'https://www.toutiao.com/';

export interface LoginFlowOptions {
  session: ToutiaoBrowserSession;
  /** 收藏列表 URL。未传时导航到首页。 */
  favoritesUrl?: string;
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
  /** 登录成功后从页面提取的收藏页 URL（绝对路径）。 */
  favoritesUrl?: string;
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

  // 如果有收藏页 URL 就用它；否则用首页
  const targetUrl = opts.favoritesUrl ?? TOUTIAO_HOME;
  // 用 domcontentloaded 而非 networkidle——首页广告/追踪请求会让 networkidle 很慢
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  // auth.login 的目的是让用户手动登录，不做首轮自动检测。
  // 等待用户在浏览器中完成登录，轮询检测登录态。
  let signals: Partial<LoginSignals> = {};
  let state: LoginState = 'auth-state-unknown';

  // 等待用户手动登录
  const timeoutMs = opts.loginTimeoutMs ?? 300_000;
  const pollMs = opts.pollIntervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;

  // 首轮检测前等待页面渲染（不等完整 networkidle，只等 DOM 元素出现）
  await page.waitForSelector('.ttp-header-profile, .header-profile-wrapper, .user-icon', {
    timeout: 10_000,
  }).catch(() => {});

  // 合并头像+用户名检测为单次 evaluate，减少往返
  while (Date.now() < deadline) {
    const loginCheck = await page.evaluate(() => {
      const profile = document.querySelector('.ttp-header-profile img, .header-profile-wrapper img, .user-icon img');
      const nameEl = document.querySelector('.ttp-header-profile .name, .header-profile-wrapper .name');
      const hasAvatar = profile !== null;
      const hasName = nameEl !== null && (nameEl.textContent?.trim().length ?? 0) > 0;
      return { hasAvatar, hasName };
    }).catch(() => ({ hasAvatar: false, hasName: false }));

    if (loginCheck.hasAvatar && loginCheck.hasName) {
      signals = await collectLoginSignals(page, targetUrl);
      state = 'logged-in';
      // 登录成功后从页面提取收藏页 URL
      const favUrl = await extractFavoritesUrl(page);
      if (ownsPage) await page.close();
      return { state, signals, ...(favUrl !== undefined ? { favoritesUrl: favUrl } : {}) };
    }

    // 首轮不等 pollMs（已登录时立即检测），后续轮询等待
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  // 超时：返回最终状态
  signals = await collectLoginSignals(page, targetUrl);
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

/**
 * 从头条页面提取收藏页 URL。
 * 用户下拉菜单中有「我的收藏」链接，href 含 tab=fav。
 * 链接可能需要等待页面完全渲染后才出现，最多等待 5 秒。
 */
async function extractFavoritesUrl(page: Page): Promise<string | undefined> {
  try {
    // 轮询等待收藏链接出现（最多 3 秒）
    for (let attempt = 0; attempt < 6; attempt++) {
      const href = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        // 查找含 tab=fav 的链接（收藏页链接）
        const favLink = links.find((a) => {
          const h = a.getAttribute('href') ?? '';
          return h.includes('tab=fav');
        });
        return favLink?.getAttribute('href') ?? null;
      });

      if (href !== null) {
        // 相对路径转绝对路径
        if (href.startsWith('http')) return href;
        return `https://www.toutiao.com${href}`;
      }

      // 还没找到，hover 用户头像区域展开下拉菜单
      if (attempt === 0) {
        try {
          await page.locator('.ttp-header-profile, .header-profile-wrapper').first().hover({ timeout: 2000 });
          await page.waitForTimeout(300);
        } catch {
          // hover 失败不影响后续尝试
        }
      }
      await page.waitForTimeout(300);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
