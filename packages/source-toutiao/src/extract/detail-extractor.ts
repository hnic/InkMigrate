import type { SourceDegradation } from '@inkmigrate/core';
import { JSDOM } from 'jsdom';
import { extractStructuredDataFromDoc } from './structured-data.js';
import { readabilityFallbackFromDoc } from './readability-fallback.js';
import { runSafetyPipeline } from '../pipeline/pipeline.js';
import { SPECIAL_PAGE_SELECTORS } from '../selectors/index.js';

export interface DetailInput {
  html: string;
  canonicalUrl: string;
  /**
   * 原始（规范化前）URL。本提取器按"导航后拿到的 HTML 快照"工作，此时重定向
   * 已发生完毕——originalUrl 与 canonicalUrl 都是导航前口径，二者比对检不出
   * 登录重定向（那需要浏览器侧 page.url()，见 adapter/unfavorite-driver）。
   * 保留该字段是为了调用方（extract-driver）契约稳定与后续诊断用途。
   */
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
 *
 * 性能优化：只解析一次 JSDOM，detectSpecialPage/extractAuthor/extractTime 复用。
 */
export function extractDetail(i: DetailInput): DetailResult {
  // 解析一次 JSDOM，后续复用 document 对象。
  // §12.9 stage 1：不设置 runScripts（jsdom 默认）即完全禁用脚本执行；
  // 'outside-only' 仍会在 window 上安装 eval，解析不可信页面 HTML 时不应保留。
  const dom = new JSDOM(i.html, { url: i.canonicalUrl });
  try {
    const doc = dom.window.document;

    // 先检测特殊情况：删除/登录/验证码
    const special = detectSpecialPageFromDoc(doc);
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

    // 提取元数据（JSON-LD/OG）。§11 性能：复用上方已解析的 doc，避免重复 new JSDOM
    // （structured-data 与 readability-fallback 原本各自对 i.html 再 parse 一次）。
    const sd = extractStructuredDataFromDoc(doc);
    const rb = readabilityFallbackFromDoc(doc);
    const title =
      sd.headline ??
      sd.title ??
      rb.title ??
      deriveTitleFromUrl(i.canonicalUrl);

    // 选正文 HTML：用 readability 回退
    const bodyHtml = rb.contentHtml;

    // §12.9 安全流水线
    const pipeline = runSafetyPipeline(bodyHtml, {
      baseUrl: i.canonicalUrl,
    });

    // 从已解析的 DOM 提取 author/time（不再重复创建 JSDOM）
    const author = sd.author ?? extractAuthorFromDoc(doc);
    const publishedAt = sd.datePublished ?? extractTimeFromDoc(doc);

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
  } finally {
    // 释放 jsdom window（计时器/监听器/DOM 图），与 readability-fallback /
    // structured-data 的独立入口一致——长爬取进程不 close 会持续滞留内存
    dom.window.close();
  }
}

function detectSpecialPageFromDoc(doc: Document): SourceDegradation | undefined {
  // L8: 用全部选择器 join，与 unfavorite-driver 一致。
  // 但 joined 选择器命中"文档任意位置"即整页降级——正常文章页内嵌的登录/验证码
  // 组件（评论区滑块、错误占位 div）不应把有效页面判成特殊页：仅当页面不存在
  // 任何可提取正文容器时才按特殊页处理（与 loginRequired 排除 .login-guide 的
  // 先例同一权衡）。
  const hasBodyContainer =
    doc.querySelector('.article-content, .post-content, article') !== null;
  if (hasBodyContainer) return undefined;
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.contentDeleted.join(', '))) {
    return {
      code: 'content-unavailable',
      stage: 'extract',
      message: 'content deleted or not found',
    };
  }
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.loginRequired.join(', '))) {
    return {
      code: 'partial-visibility',
      stage: 'extract',
      message: 'login required to view full content',
    };
  }
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.securityChallenge.join(', '))) {
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
    // slice(0, 2).join('/') 避免单段路径（典型 /<id>/）产出 "<id>/" 这种
    // 带悬挂斜杠的标题；decodeURIComponent 让百分号编码段可读
    return segs.length > 0 ? segs.slice(0, 2).map(decodeURIComponent).join('/') : u.hostname;
  } catch {
    return 'unknown';
  }
}

function extractAuthorFromDoc(doc: Document): string | undefined {
  // 已知局限：querySelector 取文档序首个，真实页面上可能命中评论作者/侧栏作者
  // 而非文章作者，textContent 也会带上"· 关注 | 3小时前"等装饰文案。仅在
  // 结构化数据（JSON-LD/OG，见上方 sd.author 优先级）缺失时兜底；待真实页面
  // 确认 byline 容器结构后再收紧作用域，避免现在凭猜测误伤。
  const el = doc.querySelector('.author-name, .author');
  const v = el?.textContent?.trim();
  return v || undefined;
}

function extractTimeFromDoc(doc: Document): string | undefined {
  const el = doc.querySelector('time');
  const v = el?.getAttribute('datetime') ?? el?.textContent?.trim();
  if (!v) return undefined;
  // 过滤 "2小时前" / "昨天 22:31" 等相对/本地化文案：不可解析的值进入
  // publishedAt 会让下游时间解析与排序拿到原始文案而非日期
  return Number.isNaN(Date.parse(v)) ? undefined : v;
}
