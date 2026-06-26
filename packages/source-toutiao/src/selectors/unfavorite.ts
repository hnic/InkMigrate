/**
 * §12.7 / §14 取消收藏操作选择器，集中在 packages/source-toutiao/src/selectors/。
 *
 * 用于 unfavorite-driver / adapter.cleanup / state-detector / action-verifier。
 * 文章详情页的收藏按钮与状态标记集中在此，源站改版时只改本文件。
 *
 * 真实文章详情页（2026-06 实测）：
 *   .detail-interaction-collect（收藏按钮容器）—— 已收藏状态的唯一真实信号是
 *   其 aria-pressed="true"（false=未收藏）。该元素【不】带 collected class。
 * fixture 用 [data-testid="favorite-button"] + aria-pressed。
 *
 * ⚠️ collectedClass 字段为旧版/未验证假设，真实页面不存在此 class，仅作回退，
 *    主信号必须用 favoritedAriaPressed / notFavoritedAriaPressed。
 *
 * 字段为候选定位器数组，按优先级排列：
 * 1. 稳定属性或测试标识（data-testid、aria-pressed）
 * 2. CSS class（真实页面唯一稳定锚点，作为回退）
 */
export const UNFAVORITE_SELECTORS = {
  // 收藏按钮容器（按优先级）
  // 真实页面 .detail-interaction-collect；fixture [data-testid="favorite-button"]
  collectButton: [
    '[data-testid="favorite-button"]',
    '.detail-interaction-collect',
  ],
  /** 表示「已收藏」状态的 CSS class（⚠️ 真实页面不存在，仅作回退）。主信号用 aria-pressed。 */
  collectedClass: 'collected',
  /** aria-pressed 取值：true=已收藏，false=未收藏。 */
  favoritedAriaPressed: 'true',
  notFavoritedAriaPressed: 'false',
  /** 操作成功的辅助确认标记（fixture）。 */
  successMarker: ['[data-testid="unfavorite-success"]'],
} as const;
