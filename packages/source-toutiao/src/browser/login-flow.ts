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

/** 单轮 header DOM 检测结果（runLoginFlow 轮询内 page.evaluate 的返回形状）。 */
interface LoginHeaderCheck {
  hasAvatar: boolean;
  hasName: boolean;
  hasLoginButton: boolean;
  headerRendered: boolean;
}

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
  // §I-E：把获取页面之后的逻辑整体包进 try/finally。
  // collectLoginSignals 内部会 page.context().cookies()，可能抛错；若不包 finally，
  // 抛错时 `if (ownsPage) await page.close()` 会被跳过 → 页面泄漏。
  try {
    // 用 domcontentloaded 而非 networkidle——首页广告/追踪请求会让 networkidle 很慢
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    // auth.login 的目的是让用户手动登录，不做首轮自动检测。
    // 等待用户在浏览器中完成登录，轮询检测登录态。
    const timeoutMs = opts.loginTimeoutMs ?? 300_000;
    const pollMs = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutMs;

    // 首轮检测前等待页面渲染（不等完整 networkidle，只等 DOM 元素出现）
    // 等登录按钮（未登录）或用户头像（已登录）之一出现——两者都标志 header 已渲染
    await page.waitForSelector('.login-button, .ttp-header-profile .user-icon', {
      timeout: 10_000,
    }).catch(() => {});

    // 合并头像+用户名检测为单次 evaluate，减少往返
    let isFirstRound = true;
    // 记录首轮是否见到登录按钮——用于判断"按钮消失"是登录成功还是页面根本没渲染
    let firstRoundHadLoginButton: boolean | null = null;

    /** 单轮 DOM 检测：header 是否渲染 + 头像/用户名/登录按钮是否存在。 */
    const evaluateLoginCheck = (): Promise<LoginHeaderCheck> =>
      page
        .evaluate(() => {
          // 未登录时 header 是 <a class="login-button">；登录后头像在 .user-icon > a > img
          const hasLoginButton = document.querySelector('.login-button') !== null;
          const profile = document.querySelector(
            '.ttp-header-profile img, .header-profile-wrapper img, .user-icon img',
          );
          const hasAvatar = profile !== null;
          // 头条改版后用户名不在 .name 元素里，而在头像链接的 aria-label 属性
          const userIcon = document.querySelector(
            '.ttp-header-profile .user-icon, .header-profile-wrapper .user-icon',
          );
          const nameFromLabel = userIcon?.querySelector('a')?.getAttribute('aria-label')?.trim();
          const hasName = (nameFromLabel?.length ?? 0) > 0;
          // header 区是否已渲染（避免对空白页误判）
          const headerRendered =
            document.querySelector('.ttp-header-profile, .ttp-site-header, header') !== null;
          return { hasAvatar, hasName, hasLoginButton, headerRendered };
        })
        .catch(() => ({
          hasAvatar: false,
          hasName: false,
          hasLoginButton: true,
          headerRendered: false,
        }));

    /**
     * 命中判定（两个独立条件，任一满足）：
     *   A. 正向：头像 + 用户名都存在（aria-label 命中）
     *   B. 负向：首轮见过登录按钮、之后消失（真·登录态翻转）
     * 两个条件都要求 headerRendered：SPA 局部重渲染导致 header 短暂卸载时，
     * .login-button 查询不到，不能据此判定"按钮消失 = 已登录"。
     */
    const isLoginConfirmed = (check: LoginHeaderCheck): boolean => {
      if (!check.headerRendered) return false;
      const positive = check.hasAvatar && check.hasName;
      const loginButtonGone =
        firstRoundHadLoginButton === true && !check.hasLoginButton;
      return positive || loginButtonGone;
    };

    /**
     * 成功出口：收集信号并用 detectLoginState 交叉校验（与超时出口同一标准）。
     * DOM 判定与 URL/遮罩信号矛盾（如 URL 仍停在登录页、登录遮罩仍在）时降级为
     * auth-state-unknown，不直接宣布 logged-in。
     */
    const finishLoggedIn = async (): Promise<LoginFlowResult> => {
      const signals = await collectLoginSignals(page, targetUrl);
      const state: LoginState =
        detectLoginState(signals) === 'not-logged-in' ? 'auth-state-unknown' : 'logged-in';
      // 登录成功后从页面提取收藏页 URL
      const favUrl = await extractFavoritesUrl(page);
      return { state, signals, ...(favUrl !== undefined ? { favoritesUrl: favUrl } : {}) };
    };

    while (Date.now() < deadline) {
      const loginCheck = await evaluateLoginCheck();

      if (firstRoundHadLoginButton === null && loginCheck.headerRendered) {
        firstRoundHadLoginButton = loginCheck.hasLoginButton;
      }

      if (isLoginConfirmed(loginCheck)) {
        return await finishLoggedIn();
      }

      // 首轮不等 pollMs（已登录时 waitForSelector 后立即检测），后续轮询等待
      if (!isFirstRound) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      isFirstRound = false;
    }

    // 超时前最后做一次 DOM 检测：用户在 deadline 附近完成登录时，最后一轮轮询
    // 可能刚好错过，直接走 detectLoginState 会因 URL 尚未跳转等瞬时负向信号
    // 误判为 not-logged-in——等价于"再多跑一轮"的判定。
    const finalCheck = await evaluateLoginCheck();
    if (isLoginConfirmed(finalCheck)) {
      return await finishLoggedIn();
    }

    // 超时：返回最终状态
    const timeoutSignals = await collectLoginSignals(page, targetUrl);
    const timeoutState = detectLoginState(timeoutSignals);
    return { state: timeoutState, signals: timeoutSignals };
  } finally {
    // 无论正常返回还是 collectLoginSignals 抛错，都确保关闭自有的页面，避免泄漏。
    if (ownsPage) {
      await page.close();
    }
  }
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

  // cookieExists: 检查头条会话 Cookie（仅辅助信号）。
  // cookies() 可能抛错（如用户手动关闭浏览器导致 context 销毁）——cookie 只是
  // 辅助信号，失败时跳过即可，不能让用户已完成的手动登录以异常收场。
  try {
    const cookies = await page.context().cookies();
    // 精确匹配头条会话 Cookie 名：includes('token') 之类子串匹配会命中 msToken
    // 等 SDK 给每个访客都种的 cookie，使该信号沦为无信息量的噪声
    const SESSION_COOKIE_NAMES = new Set([
      'sessionid',
      'sessionid_ss',
      'sid_guard',
      'sid_tt',
    ]);
    if (cookies.some((c) => SESSION_COOKIE_NAMES.has(c.name))) {
      signals.cookieExists = true;
    }
  } catch {
    // 忽略：cookie 仅为辅助信号
  }

  return signals;
}

/**
 * 从头条页面提取收藏页 URL。
 * 用户下拉菜单中有「我的收藏」链接，href 含 tab=fav。
 * 链接可能需要等待页面完全渲染后才出现：首轮 hover 最多约 2.3s，
 * 随后 6 轮 × 300ms 轮询，总预算约 4 秒。
 */
async function extractFavoritesUrl(page: Page): Promise<string | undefined> {
  try {
    // 轮询等待收藏链接出现（6 轮 × 300ms，含首轮 hover 总预算约 4 秒）
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
        // 相对路径转绝对路径：交给 URL 解析处理无前导斜杠（'u/123?tab=fav'）、
        // 协议相对（'//host/…'）等形态，裸拼接会产生 'https://www.toutiao.comu/…'
        // 之类的畸形 URL
        if (href.startsWith('http://') || href.startsWith('https://')) return href;
        return new URL(href, TOUTIAO_HOME).href;
      }

      // 还没找到，hover 用户头像区域展开下拉菜单（收藏链接在 .user-list 下拉里）
      // 改版后下拉挂在 .user-icon 下，hover 它才能展开
      if (attempt === 0) {
        try {
          await page
            .locator('.ttp-header-profile .user-icon, .ttp-header-profile, .header-profile-wrapper')
            .first()
            .hover({ timeout: 2000 });
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
