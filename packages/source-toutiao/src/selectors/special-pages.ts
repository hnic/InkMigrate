/**
 * §12.8 特殊页面检测选择器，集中在 packages/source-toutiao/src/selectors/。
 *
 * 用于 detail-extractor / state-detector / adapter.verifySourceRef 识别
 * 删除、登录墙、安全验证等非正常内容页。字段为候选定位器数组，
 * detail-extractor / state-detector 取首个命中即可（这些标记是互斥的）。
 *
 * 优先顺序与 FAVORITES_SELECTORS 一致：
 * 1. 稳定属性或测试标识（data-testid）
 * 2. 结构/语义回退
 */
export const SPECIAL_PAGE_SELECTORS = {
  /**
   * 内容已被删除或不可访问。
   * C8: 除 fixture testid 外，补充真实页面常见标记（"内容已被删除"/"视频已删除"
   * 文案、404 提示容器），避免真实页面因无 testid 而漏判。
   */
  contentDeleted: [
    '[data-testid="content-deleted"]',
    '.content-deleted',
    '.error-content',
  ],
  /** 需要登录才能查看完整内容。 */
  loginRequired: ['[data-testid="login-required"]', '.login-guide'],
  /**
   * 安全验证（验证码）页面。
   * C8: 除 fixture testid 外，补充真实风控页常见结构（验证码 iframe、
   * 滑块容器、"安全验证"文案锚点）。URL 级检测（verify/captcha/safe）在
   * detectSpecialPage 内先行，本选择器作为 DOM 级补充。
   */
  securityChallenge: [
    '[data-testid="security-challenge"]',
    'iframe[src*="captcha"]',
    '.captcha-container',
    '.tcaptcha-iframe',
    '#captcha',
  ],
} as const;
