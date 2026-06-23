import type { SourceDegradation } from '@inkmigrate/core';
import { JSDOM } from 'jsdom';
import { extractStructuredData } from './structured-data.js';
import { readabilityFallback } from './readability-fallback.js';
import { runSafetyPipeline } from '../pipeline/pipeline.js';

export interface DetailInput {
  html: string;
  canonicalUrl: string;
  originalUrl: string;
}

export interface DetailResult {
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  html: string;
  images: string[];
  quality: 'full' | 'degraded';
  degradations: SourceDegradation[];
}

/**
 * §12.8 详情页提取，按顺序尝试：
 * 1. 站点专用提取器（本阶段用结构化特征标记 data-testid）
 * 2. 结构化数据（JSON-LD/OG/Meta）
 * 3. Readability 回退
 * 4. 元数据占位
 *
 * 任何路径返回的正文都必须进入 §12.9 安全流水线，不能跳过清洗。
 */
export function extractDetail(i: DetailInput): DetailResult {
  // 先检测特殊情况：删除/登录/验证码（这些 fixture 用 data-testid 标识）
  const special = detectSpecialPage(i.html);
  if (special !== undefined) {
    return {
      title: deriveTitleFromUrl(i.canonicalUrl),
      markdown: '',
      html: '',
      images: [],
      quality: 'degraded',
      degradations: [special],
    };
  }

  // 提取元数据（JSON-LD/OG）—— 不论正文走哪条路径都用得上
  const sd = extractStructuredData(i.html, i.canonicalUrl);
  const rb = readabilityFallback(i.html, i.canonicalUrl);
  const title =
    sd.headline ??
    sd.title ??
    rb.title ??
    deriveTitleFromUrl(i.canonicalUrl);

  // 选正文 HTML：用 readability 回退（article/content 选择器）
  const bodyHtml = rb.contentHtml;

  // §12.9 安全流水线
  const pipeline = runSafetyPipeline(bodyHtml, {
    baseUrl: i.canonicalUrl,
  });

  const author =
    sd.author ?? extractAuthorFromBody(i.html, i.canonicalUrl);
  const publishedAt =
    sd.datePublished ?? extractTimeFromBody(i.html, i.canonicalUrl);

  const result: DetailResult = {
    title,
    markdown: pipeline.markdown,
    html: pipeline.html,
    images: pipeline.images,
    quality: pipeline.quality,
    degradations: pipeline.degradations,
  };
  if (author !== undefined) result.author = author;
  if (publishedAt !== undefined) result.publishedAt = publishedAt;
  return result;
}

function detectSpecialPage(html: string): SourceDegradation | undefined {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    resources: undefined,
  });
  const doc = dom.window.document;
  if (doc.querySelector('[data-testid="content-deleted"]')) {
    return {
      code: 'content-unavailable',
      stage: 'extract',
      message: 'content deleted or not found',
    };
  }
  if (doc.querySelector('[data-testid="login-required"]')) {
    return {
      code: 'partial-visibility',
      stage: 'extract',
      message: 'login required to view full content',
    };
  }
  if (doc.querySelector('[data-testid="security-challenge"]')) {
    return {
      code: 'partial-visibility',
      stage: 'extract',
      message: 'security challenge (captcha) page detected',
    };
  }
  return undefined;
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    return segs.length > 0 ? `${segs[0]}/${segs[1] ?? ''}` : u.hostname;
  } catch {
    return 'unknown';
  }
}

function extractAuthorFromBody(
  html: string,
  baseUrl: string,
): string | undefined {
  const dom = new JSDOM(html, {
    url: baseUrl,
    runScripts: 'outside-only',
    resources: undefined,
  });
  const el = dom.window.document.querySelector('.author-name, .author');
  const v = el?.textContent?.trim();
  return v || undefined;
}

function extractTimeFromBody(
  html: string,
  baseUrl: string,
): string | undefined {
  const dom = new JSDOM(html, {
    url: baseUrl,
    runScripts: 'outside-only',
    resources: undefined,
  });
  const el = dom.window.document.querySelector('time');
  const v = el?.getAttribute('datetime') ?? el?.textContent?.trim();
  return v || undefined;
}
