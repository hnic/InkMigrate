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
   * 注意：当前仅覆盖 fixture testid 与 .content-deleted 类名；
   * 真实页面"内容已被删除/视频已删除"文案与 404 提示容器尚未覆盖
   *（JSDOM querySelector 不支持 :has-text，文案匹配需在消费方实现）。
   * 刻意不含 .error-content：类名过于泛化，正常页面上的行内错误 UI（评论区
   * 报错、图片占位等）会命中它——三个消费方都把单次命中当整页"已删除"信号
   *（adapter 永久标 deleted、unfavorite-driver 中断、extractor 整篇降级），
   * 与 loginRequired 排除 .login-guide 是同一权衡。待真实页面确认删除提示
   * 容器结构后再以带作用域的形式补回。
   */
  contentDeleted: [
    '[data-testid="content-deleted"]',
    '.content-deleted',
  ],
  /**
   * 需要登录才能查看完整内容（仅整页登录墙判定）。
   * 刻意不含 .login-guide：未登录时正常文章页也常渲染登录引导（正文完整可见），
   * 命中它会把有效页面整篇降级为空 markdown。整页登录墙在**浏览器消费方**
   *（unfavorite-driver.detectSpecialPage / adapter.verifySourceRef）由 URL
   * 重定向检测（login/passport）兜住；detail-extractor 路径无 URL 兜底——它
   * 只拿到导航后的 HTML 快照，真实登录墙当前无法检出（已知缺口，待真实页面
   * 确认登录墙容器类名后补充）。
   */
  loginRequired: ['[data-testid="login-required"]'],
  /**
   * 安全验证（验证码）页面。URL 级检测（verify/captcha/safe）在
   * unfavorite-driver.detectSpecialPage 内先行，本选择器作为 DOM 级补充。
   * "安全验证"文案锚点无法用 CSS 选择器表达（JSDOM 不支持 :has-text），
   * 滑块容器类名待真实页面确认后再补。
   * 下面三个泛化候选（iframe[src*="captcha"] / .captcha-container / #captcha）
   * 暂不启用：它们在正常文章页也会命中行内验证码组件（如评论区滑块），单次
   * 命中即把整页判成 challenge_required 并中断编排运行。确认真实验证码页的
   * 整页容器特征后再放回（若启用 iframe 匹配，记得加 CSS 大小写不敏感旗标
   * `[src*="captcha" i]`，属性值匹配默认区分大小写）。
   */
  securityChallenge: [
    '[data-testid="security-challenge"]',
    '.tcaptcha-iframe',
    // 待真实页面验证后启用：
    // 'iframe[src*="captcha" i]',
    // '.captcha-container',
    // '#captcha',
  ],
} as const;
