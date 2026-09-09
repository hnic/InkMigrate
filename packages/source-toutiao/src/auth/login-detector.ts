export type LoginState = 'logged-in' | 'not-logged-in' | 'auth-state-unknown';

/**
 * §12.2 登录状态检测信号集。
 *
 * 注意：`cookieExists` 是辅助信号，不能单独得出 logged-in 结论（§12.2 最后一项）。
 * URL 类信号（currentUrlLeftAuthPage / redirectedToLogin / favoritesPageAccessible）
 * 在现有调用方中源自同一次 URL 探测，彼此高度相关，detectLoginState 只把它们
 * 合计为 1 个独立正向信号。
 */
export interface LoginSignals {
  /** 当前 URL 已离开登录/认证页面。 */
  currentUrlLeftAuthPage?: boolean;
  /** 页面存在已登录用户入口、头像、账号菜单或退出入口。 */
  hasUserEntryElement?: boolean;
  /** 收藏页或用户中心可正常打开，且未出现登录遮罩。 */
  favoritesPageAccessible?: boolean;
  /** 受保护页面访问后没有被重定向到登录页。 */
  redirectedToLogin?: boolean;
  /** 页面存在登录遮罩。 */
  hasLoginMask?: boolean;
  /** 网络响应返回已认证用户状态。 */
  networkAuthResponseOk?: boolean;
  /** Cookie/Local Storage 存在（仅辅助）。 */
  cookieExists?: boolean;
}

/**
 * §12.2 多信号登录状态判断。
 *
 * 规则：
 * - 至少 2 个独立正向信号 + 0 个反向信号 → logged-in。
 * - 任何反向信号 + 0 个正向信号 → not-logged-in。
 * - 正反同时存在、或只有 cookie 辅助信号、或无信号 → auth-state-unknown。
 *
 * 信号冲突时返回 auth-state-unknown 并由调用方进入人工辅助或安全暂停，
 * 不得猜测为已登录（§12.2）。
 */
export function detectLoginState(s: LoginSignals): LoginState {
  // cookieExists 为辅助信号，故意不参与计数（§12.2：不能单独得出 logged-in 结论，
  // 该契约由 login-detector.test 的 cookie-only 用例锁定）。
  // 同一次 URL 探测派生的三个信号（currentUrlLeftAuthPage / redirectedToLogin===false /
  // favoritesPageAccessible）高度相关——落到任何非认证 URL（公共 feed、错误页、
  // 软重定向）会同时为真，只能合计为 1 个独立正向信号，否则单次探测即可凑满
  // ≥2，违背 §12.2 不得猜测已登录的要求。
  const urlProbePositive =
    s.currentUrlLeftAuthPage === true ||
    s.redirectedToLogin === false ||
    s.favoritesPageAccessible === true;
  const positives: boolean[] = [
    urlProbePositive,
    s.hasUserEntryElement === true,
    s.networkAuthResponseOk === true,
  ];
  const negatives: boolean[] = [
    s.currentUrlLeftAuthPage === false,
    s.hasLoginMask === true,
    s.redirectedToLogin === true,
    s.favoritesPageAccessible === false,
    // 网络显式返回未认证状态（如受保护端点 401）与 URL 显式未离开登录页同为负向；
    // 若探测请求本身失败，调用方应不设置该信号（undefined）而非置 false
    s.networkAuthResponseOk === false,
  ];
  const positiveCount = positives.filter(Boolean).length;
  const negativeCount = negatives.filter(Boolean).length;

  if (positiveCount >= 2 && negativeCount === 0) return 'logged-in';
  if (negativeCount > 0 && positiveCount === 0) return 'not-logged-in';
  return 'auth-state-unknown';
}
