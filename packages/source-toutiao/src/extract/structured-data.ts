import { JSDOM } from 'jsdom';

export interface StructuredData {
  title?: string;
  headline?: string;
  author?: string;
  datePublished?: string;
  ogType?: string;
  ogImage?: string;
  ogUrl?: string;
  description?: string;
}

/**
 * §12.8 strategy 2：从 JSON-LD、Open Graph、Meta 标签提取结构化数据。
 * 在 jsdom 独立 DOM 上运行（不修改 Playwright 页面）。
 */
/**
 * §12.8 strategy 2：从 JSON-LD、Open Graph、Meta 标签提取结构化数据。
 * 在 jsdom 独立 DOM 上运行（不修改 Playwright 页面）。
 *
 * §11 性能：核心逻辑 `extractStructuredDataFromDoc` 直接接受已解析的 document，
 * 避免调用方（detail-extractor）对同一 html 重复 new JSDOM。下方 `extractStructuredData`
 * 保留为独立调用入口（自建 JSDOM），向后兼容。
 */
export function extractStructuredDataFromDoc(doc: Document): StructuredData {
  const out: StructuredData = {};
  _extractStructuredDataCore(doc, out);
  return out;
}

/** 原独立入口：自建 JSDOM 解析 html（供外部单独调用，不依赖调用方的 document）。 */
export function extractStructuredData(
  html: string,
  baseUrl: string,
): StructuredData {
  const dom = new JSDOM(html, {
    url: baseUrl,
    // §12.9 stage 1：所有 jsdom 实例必须显式禁用脚本执行。
    runScripts: 'outside-only',
    resources: undefined,
  });
  const out: StructuredData = {};
  _extractStructuredDataCore(dom.window.document, out);
  return out;
}

function _extractStructuredDataCore(doc: Document, out: StructuredData): void {

  // JSON-LD
  const jsonLd = doc.querySelector('script[type="application/ld+json"]');
  if (jsonLd?.textContent) {
    try {
      const parsed = JSON.parse(jsonLd.textContent) as Record<string, unknown>;
      if (typeof parsed['headline'] === 'string') out.headline = parsed['headline'];
      const author = parsed['author'];
      if (typeof author === 'object' && author !== null) {
        const name = (author as Record<string, unknown>)['name'];
        if (typeof name === 'string') out.author = name;
      } else if (typeof author === 'string') {
        out.author = author;
      }
      if (typeof parsed['datePublished'] === 'string')
        out.datePublished = parsed['datePublished'];
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Open Graph
  const meta = (prop: string): string | undefined => {
    const el = doc.querySelector(
      `meta[property="${prop}"], meta[name="${prop}"]`,
    );
    const v = el?.getAttribute('content');
    return v ?? undefined;
  };
  // 用条件赋值避免 exactOptional 传播问题
  const ogTitle = meta('og:title') ?? meta('title');
  if (ogTitle !== undefined) out.title = ogTitle;
  const ogType = meta('og:type');
  if (ogType !== undefined) out.ogType = ogType;
  const ogImage = meta('og:image');
  if (ogImage !== undefined) out.ogImage = ogImage;
  const ogUrl = meta('og:url');
  if (ogUrl !== undefined) out.ogUrl = ogUrl;
  const description = meta('og:description') ?? meta('description');
  if (description !== undefined) out.description = description;
}
