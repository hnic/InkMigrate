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
  // 单条收藏（按优先级）—— 多类型并集抓取，见 scan-driver extractItemsHtml
  // 真实页面按内容类型分多种外层容器；fixture 用 data-item-id
  item: [
    '[data-item-id]',
    // 实测：视频条目（占多数）+ 微头条。
    // 若实测发现嵌套（wrapper 内还有 .feed-card-wrapper），需加 :not() 作用域
    //（如 '.feed-card-wrapper:not(.profile-normal-video-card-wrapper .feed-card-wrapper)'）
    // 防止同一卡片被并集重复发送、虚增 duplicateObservations。
    '.profile-normal-video-card-wrapper',
    '.feed-card-wrapper',
    // TODO(verify): 按命名规律推断的文章条目，未实测——待用含文章收藏的账号
    // 验证真实 class。错误猜测会导致文章类收藏被静默漏抓（并集抓取不报错），
    // 扫描"成功完成"但数据不完整。
    '.profile-normal-article-card-wrapper',
    '.profile-article-card-wrapper',
    '[role="listitem"]',
    '.favorite-item',
  ],
  // 字段
  // 仅 fixture 有 data-item-id；真实页面无该属性，externalId 恒走 URL 派生兜底
  //（scanner.parseItemsFromHtml → extractToutiaoContentId）。
  // 注意：scanner 只消费 itemId[0]——与其它字段的多候选回退不同，往本数组
  // 追加候选定位器会被静默忽略，需同步改造消费方。
  itemId: ['data-item-id'],
  // 标题链接：真实页面 a.title（文章）；微头条 .content a；fixture a.title。
  // 注意：scanner 用首个命中元素同时取 title 和 href（→ canonicalUrl → 去重键），
  // 必须先放限定 href 的锚点——微头条卡片里话题/搜索链接常排在 /w/ 链接之前，
  // 命中它们会让 canonicalUrl 与去重键漂移到无关 URL。非锚点候选（.title/
  // [role="heading"]）刻意不列入：无 href 会让条目折叠到列表页 URL（全部
  // 挤成同一个去重键）；这类条目由 scanner 的内容链接兜底选择器接管更安全。
  title: [
    'a.title[href]',
    '.content a[href*="/w/"]',
    'a.title',
    '.content a[href]',
  ],
  author: ['.author', '.author-name', '.feed-card-source'],
  summary: ['.summary'],
  // 封面：真实页面 .feed-card-cover img；fixture .cover img
  cover: ['.feed-card-cover img', '.cover img', 'img.cover'],
  contentType: ['.content-type'],
  publishedTime: ['time[datetime]', 'time', '.feed-card-time'],
  collectionName: ['.collection-name'],
  // 内容链接兜底：条目内任意内容路径锚点。与 normalize/url.ts 的
  // extractToutiaoContentId 路径正则同口径维护——新增内容路径需两处同步，
  // 否则 scanner 兜底抓不到新路径（条目被跳过）或抓到非内容链接。
  contentLink:
    'a[href*="/article/"], a[href*="/a/"], a[href*="/video/"], a[href*="/wenda/"], a[href*="/group/"], a[href*="/w/"]',
  // 加载更多
  loadMore: [
    '[data-testid="load-more-button"]',
    '.load-more',
    'button.load-more',
  ],
} as const;
