export type LoginState = 'logged-in' | 'not-logged-in' | 'auth-state-unknown';

/**
 * §12.2 登录状态检测信号集。
 *
 * 注意：`cookieExists` 是辅助信号，不能单独得出 logged-in 结论（§12.2 最后一项）。
 * 其余信号是独立的。
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
  const positives: boolean[] = [
    s.currentUrlLeftAuthPage === true,
    s.hasUserEntryElement === true,
    s.favoritesPageAccessible === true,
    s.networkAuthResponseOk === true,
    s.redirectedToLogin === false, // 没被重定向是正向
  ];
  const negatives: boolean[] = [
    s.currentUrlLeftAuthPage === false,
    s.hasLoginMask === true,
    s.redirectedToLogin === true,
    s.favoritesPageAccessible === false,
  ];
  const positiveCount = positives.filter(Boolean).length;
  const negativeCount = negatives.filter(Boolean).length;

  if (positiveCount >= 2 && negativeCount === 0) return 'logged-in';
  if (negativeCount > 0 && positiveCount === 0) return 'not-logged-in';
  return 'auth-state-unknown';
}
