/** §12.8 详情页选择器。 */
export const DETAIL_SELECTORS = {
  article: ['article[data-testid="article-detail"]', 'article', '[role="article"]'],
  micro: ['[data-testid="micro-detail"]'],
  gallery: ['[data-testid="gallery-detail"]'],
  video: ['[data-testid="video-detail"]'],
  title: ['h1', '[role="heading"]', 'title'],
  author: ['.author-name', '.author', '[itemprop="author"]'],
  publishedTime: ['time[datetime]', 'time', '[itemprop="datePublished"]'],
  body: ['.article-content', '.content', 'article'],
  cover: ['img[data-src]', 'img.cover', 'meta[property="og:image"]'],
} as const;
