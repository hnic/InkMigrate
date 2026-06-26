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
  /** 内容已被删除或不可访问。 */
  contentDeleted: ['[data-testid="content-deleted"]'],
  /** 需要登录才能查看完整内容。 */
  loginRequired: ['[data-testid="login-required"]'],
  /** 安全验证（验证码）页面。 */
  securityChallenge: ['[data-testid="security-challenge"]'],
} as const;
