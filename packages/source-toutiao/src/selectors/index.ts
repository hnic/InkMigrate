export { FAVORITES_SELECTORS } from './favorites-list.js';
export { SPECIAL_PAGE_SELECTORS } from './special-pages.js';
export { UNFAVORITE_SELECTORS } from './unfavorite.js';
// §12.8 strategy 1（站点专用提取器）的选择器在 stage 4 真实站点验证时
// 重新加入；当前 stage 3 用 fixture 驱动，detail-extractor 走结构化数据 +
// readability 回退即可覆盖所有 fixture 路径。
