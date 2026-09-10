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
  // §12.9 stage 1：不设置 runScripts（jsdom 默认）即完全禁用脚本执行；
  // 'outside-only' 仍会在 window 上安装 eval，解析不可信 HTML 时不应保留该入口。
  const dom = new JSDOM(html, { url: baseUrl });
  try {
    const out: StructuredData = {};
    _extractStructuredDataCore(dom.window.document, out);
    return out;
  } finally {
    // 释放 jsdom window，避免爬虫长循环中累积内存
    dom.window.close();
  }
}

/** 读取单个 JSON-LD 节点的关注字段（headline/author/datePublished）。 */
function _readJsonLdNode(node: unknown, out: StructuredData): void {
  if (node === null || typeof node !== 'object') return;
  const parsed = node as Record<string, unknown>;
  if (out.headline === undefined && typeof parsed['headline'] === 'string') {
    out.headline = parsed['headline'];
  }
  const author = parsed['author'];
  if (out.author === undefined) {
    if (typeof author === 'string') {
      out.author = author;
    } else if (Array.isArray(author) && author.length > 0) {
      // JSON-LD author 常见为数组形式，取第一个 Person 的 name。
      // 元素类型必须校验：null（合法 JSON，如 "author":[null]）或字符串
      //（如 "author":["John"]，野生页面常见）直接属性访问会抛错或静默丢值
      const first = author[0];
      if (typeof first === 'string') {
        out.author = first;
      } else if (first !== null && typeof first === 'object') {
        const name = (first as Record<string, unknown>)['name'];
        if (typeof name === 'string') out.author = name;
      }
    } else if (typeof author === 'object' && author !== null) {
      const name = (author as Record<string, unknown>)['name'];
      if (typeof name === 'string') out.author = name;
    }
  }
  if (out.datePublished === undefined && typeof parsed['datePublished'] === 'string') {
    out.datePublished = parsed['datePublished'];
  }
}

/** 判断 JSON-LD 节点是否为文章实体（@type 含 Article/NewsArticle 等）。 */
function _isArticleNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const type = (node as Record<string, unknown>)['@type'];
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type : [];
  return types.some((t) => typeof t === 'string' && /Article$/.test(t));
}

function _extractStructuredDataCore(doc: Document, out: StructuredData): void {

  // JSON-LD：遍历全部 ld+json 脚本（页面常有多个）；顶层归一化为节点列表——
  // 数组形式（[{...}]）逐项读，含 @graph 的读 graph，否则按单节点处理。
  // try 只包 JSON.parse：畸形 JSON 仅跳过当前脚本块；节点读取（_readJsonLdNode）
  // 已全防御，异常不能连坐吞掉同一块里其余合法节点的字段。
  for (const jsonLd of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (!jsonLd.textContent) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonLd.textContent);
    } catch {
      // ignore malformed JSON-LD
      continue;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) _readJsonLdNode(item, out);
    } else if (parsed !== null && typeof parsed === 'object') {
      const graph = (parsed as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) {
        // @graph 节点顺序任意：WebPage/Website/BreadcrumbList 可能排在
        // NewsArticle 前，先读文章实体节点、再读其余补缺（首中即赢的口径下，
        // 避免无关实体抢占 author/datePublished）
        const articles = graph.filter(_isArticleNode);
        const rest = graph.filter((n) => !articles.includes(n));
        for (const item of articles) _readJsonLdNode(item, out);
        for (const item of rest) _readJsonLdNode(item, out);
      } else {
        _readJsonLdNode(parsed, out);
      }
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
  // 相对值（如 /pgc-image/xxx.jpg）按 baseUrl 解析为绝对 URL，否则下游拿到
  // 不可用的相对地址；解析失败（畸形值）保留原值
  const resolveUrl = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    try {
      return new URL(v, doc.baseURI).href;
    } catch {
      return v;
    }
  };
  // 用条件赋值避免 exactOptional 传播问题
  const ogTitle = meta('og:title') ?? meta('title');
  if (ogTitle !== undefined) out.title = ogTitle;
  const ogType = meta('og:type');
  if (ogType !== undefined) out.ogType = ogType;
  const ogImage = resolveUrl(meta('og:image'));
  if (ogImage !== undefined) out.ogImage = ogImage;
  const ogUrl = resolveUrl(meta('og:url'));
  if (ogUrl !== undefined) out.ogUrl = ogUrl;
  const description = meta('og:description') ?? meta('description');
  if (description !== undefined) out.description = description;
}
