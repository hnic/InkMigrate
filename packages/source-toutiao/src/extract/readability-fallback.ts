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
  contentHtml: string;
}

/**
 * §11 性能：核心逻辑 `readabilityFallbackFromDoc` 直接接受已解析的 document，
 * 避免调用方（detail-extractor）对同一 html 重复 new JSDOM。下方 `readabilityFallback`
 * 保留为独立调用入口（自建 JSDOM），向后兼容。
 */
export function readabilityFallbackFromDoc(doc: Document): ReadabilityResult {
  // 优先 `<article>`，其次带 content 类的 div
  const article =
    doc.querySelector('article') ?? doc.querySelector('[class*="content"]');
  let contentHtml = '';
  if (article) {
    contentHtml = article.innerHTML;
  } else {
    // 兜底用 body
    contentHtml = doc.body?.innerHTML ?? '';
  }

  // 标题取 `<h1>` 或 `<title>`
  const h1 = doc.querySelector('h1');
  const titleEl = doc.querySelector('title');
  const rawTitle = h1?.textContent ?? titleEl?.textContent ?? undefined;
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
  const dom = new JSDOM(html, {
    url: baseUrl,
    runScripts: 'outside-only',
    resources: undefined,
  });
  return readabilityFallbackFromDoc(dom.window.document);
}
