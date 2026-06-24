/**
 * §12.4 收藏列表选择器，集中在 packages/source-toutiao/src/selectors/。
 *
 * 字段使用多个候选定位器，优先顺序：
 * 1. 稳定属性或测试标识（data-testid、data-item-id）
 * 2. ARIA role 和可访问名称
 * 3. 结构关系
 * 4. 文案与状态组合
 * 5. CSS class 仅作为最后回退
 *
 * 真实头条收藏页 DOM 结构（2026-06 实测）：
 *   div.profile-article-card-wrapper
 *     └─ div.feed-card-wrapper.feed-card-article-wrapper
 *          └─ div.feed-card-article
 *               ├─ div.feed-card-article-r > div.feed-card-cover > a[href] > img
 *               └─ div.feed-card-article-l > a.title[href="/article/..."]
 */
export const FAVORITES_SELECTORS = {
  // 列表容器（按优先级）
  listContainer: [
    '[data-testid="favorites-list"]',
    '[role="list"][aria-label*="收藏"]',
    '.profile-tab-feed',
    '.favorites-list',
  ],
  // 单条收藏（按优先级）
  // 真实页面用 .feed-card-wrapper；fixture 用 data-item-id
  item: [
    '[data-item-id]',
    '.feed-card-wrapper',
    '.profile-article-card-wrapper',
    '[role="listitem"]',
    '.favorite-item',
  ],
  // 字段
  itemId: ['data-item-id'],
  // 标题链接：真实页面 a.title；fixture .title
  title: ['a.title', '.title', '[role="heading"]'],
  author: ['.author', '.author-name', '.feed-card-source'],
  summary: ['.summary'],
  // 封面：真实页面 .feed-card-cover img；fixture .cover img
  cover: ['.feed-card-cover img', '.cover img', 'img.cover'],
  contentType: ['.content-type'],
  publishedTime: ['time[datetime]', 'time', '.feed-card-time'],
  collectionName: ['.collection-name'],
  // 加载更多
  loadMore: [
    '[data-testid="load-more-button"]',
    '.load-more',
    'button.load-more',
  ],
} as const;
