/**
 * §12.4 收藏列表选择器，集中在 packages/source-toutiao/src/selectors/。
 *
 * 字段使用多个候选定位器，优先顺序：
 * 1. 稳定属性或测试标识（data-testid、data-item-id）
 * 2. ARIA role 和可访问名称
 * 3. 结构关系
 * 4. 文案与状态组合
 * 5. CSS class 仅作为最后回退
 */
export const FAVORITES_SELECTORS = {
  // 列表容器（按优先级）
  listContainer: [
    '[data-testid="favorites-list"]',
    '[role="list"][aria-label*="收藏"]',
    '.favorites-list',
  ],
  // 单条
  item: ['[data-item-id]', '[role="listitem"]', '.favorite-item'],
  // 字段
  itemId: ['data-item-id'],
  title: ['.title', 'a.title', '[role="heading"]'],
  author: ['.author', '.author-name'],
  summary: ['.summary'],
  cover: ['.cover img', 'img.cover'],
  contentType: ['.content-type'],
  publishedTime: ['time[datetime]', 'time'],
  collectionName: ['.collection-name'],
  // 加载更多
  loadMore: [
    '[data-testid="load-more-button"]',
    '.load-more',
    'button.load-more',
  ],
} as const;
