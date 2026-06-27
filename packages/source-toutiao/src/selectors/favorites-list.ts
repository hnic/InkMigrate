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
 *   按内容类型分多种外层容器（同一收藏页混合出现）：
 *     - 文章：div.profile-normal-article-card-wrapper（按命名规律推断，未实测）
 *     - 视频：div.profile-normal-video-card-wrapper（实测，占多数）
 *              └─ div.profile-normal-video-card > div.r-content > div.feed-video-item
 *                   └─ div.feed-card-cover > a[href="/video/..."] > img
 *     - 微头条：div.feed-card-wrapper（实测）
 *                └─ a[href="/w/..."]
 *   老结构 .feed-card-wrapper.feed-card-article-wrapper 仍保留作回退。
 *
 * 注意：scan-driver 合并【所有】item 选择器的并集（非取第一个），因同一页面
 * 视频文章微头条混合出现，单选一种选择器会漏掉其它类型。
 */
export const FAVORITES_SELECTORS = {
  // 列表容器（按优先级）
  listContainer: [
    '[data-testid="favorites-list"]',
    '[role="list"][aria-label*="收藏"]',
    '.profile-tab-feed',
    '.profile-feed',
    '.favorites-list',
  ],
  // 单条收藏（按优先级）—— 多类型并集抓取，见 scan-driver extractItemsHtml
  // 真实页面按内容类型分多种外层容器；fixture 用 data-item-id
  item: [
    '[data-item-id]',
    // 实测：视频条目（占多数）+ 微头条
    '.profile-normal-video-card-wrapper',
    '.feed-card-wrapper',
    // 按命名规律推断的文章条目（本次测试账号无文章收藏，未实测）
    '.profile-normal-article-card-wrapper',
    '.profile-article-card-wrapper',
    '[role="listitem"]',
    '.favorite-item',
  ],
  // 字段
  itemId: ['data-item-id'],
  // 标题链接：真实页面 a.title（文章）；微头条 .content a；fixture .title
  title: ['a.title', '.content a[href]', '.title', '[role="heading"]'],
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
