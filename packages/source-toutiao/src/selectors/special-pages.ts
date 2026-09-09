/**
 * §12.8 特殊页面检测选择器，集中在 packages/source-toutiao/src/selectors/。
 *
 * 用于 detail-extractor / unfavorite-driver.detectSpecialPage /
 * adapter.verifySourceRef 识别删除、登录墙、安全验证等非正常内容页。
 * 字段为候选定位器数组，消费方将各候选 join 后整体匹配（querySelector /
 * locator.count）。注意：三类标记在真实页面上并不严格互斥，不同消费方的
 * 检查顺序也不同（detail-extractor 先查删除，unfavorite-driver 先查登录），
 * 新增选择器时需确认对两个消费方都安全。
 *
 * 文案类标记（"内容已被删除"/"安全验证"等）无法用 CSS 选择器表达
 * （JSDOM querySelector 不支持 :has-text），如需覆盖应在消费方做文本匹配。
 *
 * 优先顺序与 FAVORITES_SELECTORS 一致：
 * 1. 稳定属性或测试标识（data-testid）
 * 2. 结构/语义回退
 */
export const SPECIAL_PAGE_SELECTORS = {
  /**
   * 内容已被删除或不可访问。
   * 注意：当前仅覆盖 fixture testid 与 .content-deleted/.error-content 类名；
   * 真实页面"内容已被删除/视频已删除"文案与 404 提示容器尚未覆盖
   * （JSDOM querySelector 不支持 :has-text，文案匹配需在消费方实现）。
   */
  contentDeleted: [
    '[data-testid="content-deleted"]',
    '.content-deleted',
    '.error-content',
  ],
  /**
   * 需要登录才能查看完整内容（仅整页登录墙判定）。
   * 刻意不含 .login-guide：未登录时正常文章页也常渲染登录引导（正文完整可见），
   * 命中它会把有效页面整篇降级为空 markdown。整页登录墙主要由消费方的
   * URL 重定向检测（login/passport）兜住。
   */
  loginRequired: ['[data-testid="login-required"]'],
  /**
   * 安全验证（验证码）页面。URL 级检测（verify/captcha/safe）在
   * unfavorite-driver.detectSpecialPage 内先行，本选择器作为 DOM 级补充。
   * "安全验证"文案锚点无法用 CSS 选择器表达（JSDOM 不支持 :has-text），
   * 滑块容器类名待真实页面确认后再补。
   */
  securityChallenge: [
    '[data-testid="security-challenge"]',
    'iframe[src*="captcha"]',
    '.captcha-container',
    '.tcaptcha-iframe',
    '#captcha',
  ],
} as const;
