import { JSDOM } from 'jsdom';

/**
 * §12.8 strategy 3：Readability 风格的正文回退。
 *
 * 由于 `@mozilla/readability` 依赖 DOM API 且配置复杂，本阶段用最小启发式
 * 实现：找最长的 `<article>` 或 `<div class*="content">`，作为正文 HTML。
 * 真实 Readability 库可在后续阶段替换（接口保持一致）。
 */
export interface ReadabilityResult {
  title?: string;
  /** 未清洗的原始正文 HTML（可含 script/事件属性）：必须经 §12.9 安全流水线清洗后才可进入任何 DOM，禁止直接 innerHTML 插入。 */
  contentHtml: string;
}

/**
 * §11 性能：核心逻辑 `readabilityFallbackFromDoc` 直接接受已解析的 document，
 * 避免调用方（detail-extractor）对同一 html 重复 new JSDOM。下方 `readabilityFallback`
 * 保留为独立调用入口（自建 JSDOM），向后兼容。
 */
export function readabilityFallbackFromDoc(doc: Document): ReadabilityResult {
  // L9: 优先级修正——先尝试头条/常见博客的精确正文容器（.article-content / .post-content），
  // 再回退 <article>，最后才是宽泛的 [class*="content"]。
  const article =
    doc.querySelector('.article-content') ??
    doc.querySelector('.post-content') ??
    doc.querySelector('article') ??
    // 宽泛回退：querySelector 只取文档序首个，常命中 .ad-content / .sidebar-content
    // 等非正文容器；改为过滤明显非正文后取文本最长者，与头部注释"找最长"一致。
    Array.from(doc.querySelectorAll('[class*="content"]'))
      .filter((el) => !/\b(ad|sidebar|comment|footer|related)\b/i.test(String(el.className)))
      .sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0))[0];
  let contentHtml = '';
  if (article) {
    contentHtml = article.innerHTML;
  } else {
    // 兜底用 body
    contentHtml = doc.body?.innerHTML ?? '';
  }

  // 标题：优先正文子树内的 <h1>（全文档首个 h1 常是站点页头/logo），
  // 再回退 og:title（头条详情页标准元数据）与 <title>
  const h1 = article?.querySelector('h1') ?? doc.querySelector('h1');
  const ogTitle =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || undefined;
  const titleEl = doc.querySelector('title');
  const rawTitle = h1?.textContent ?? ogTitle ?? titleEl?.textContent ?? undefined;
  const title = rawTitle?.trim() || undefined;

  const result: ReadabilityResult = { contentHtml };
  if (title !== undefined) result.title = title;
  return result;
}

/** 原独立入口：自建 JSDOM 解析 html（供外部单独调用）。 */
export function readabilityFallback(
  html: string,
  baseUrl: string,
): ReadabilityResult {
  // §12.9 stage 1：不设置 runScripts（jsdom 默认）即完全禁用脚本执行；
  // 纯解析无需 'outside-only'（其仍会在 window 上安装 eval）。
  const dom = new JSDOM(html, { url: baseUrl });
  try {
    return readabilityFallbackFromDoc(dom.window.document);
  } finally {
    // 释放 jsdom window（内部计时器/监听器/DOM 图），避免批量页面处理时内存滞留
    dom.window.close();
  }
}
