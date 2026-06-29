import { describe, it, expect } from 'vitest';
import { extractStructuredData } from '../src/extract/structured-data.js';
import { extractDetail } from '../src/extract/detail-extractor.js';
import { loadFixture } from './helpers/fixtures.js';

const BASE_URL = 'https://www.toutiao.com/article/7428193012345678901/';

describe('extractStructuredData (§12.8 strategy 2)', () => {
  it('extracts JSON-LD NewsArticle', () => {
    const html = loadFixture('article');
    const sd = extractStructuredData(html, BASE_URL);
    expect(sd.headline).toBe('人工智能如何改变软件开发');
    expect(sd.author).toBe('示例作者');
    expect(sd.datePublished).toBe('2025-12-20T10:35:00+08:00');
  });

  it('extracts Open Graph fallback fields', () => {
    const html = loadFixture('video');
    const sd = extractStructuredData(
      html,
      'https://www.toutiao.com/video/123/',
    );
    expect(sd.title).toBe('AI 编程实战视频');
    expect(sd.ogType).toBe('video');
  });

  it('returns empty for no structured data', () => {
    const sd = extractStructuredData('<p>nothing</p>', BASE_URL);
    expect(sd.headline).toBeUndefined();
  });
});

describe('extractDetail (§12.8 四策略 + §12.9 pipeline)', () => {
  it('extracts an article via site extractor / structured data / readability', () => {
    const html = loadFixture('article');
    const result = extractDetail({
      html,
      canonicalUrl: BASE_URL,
      originalUrl: BASE_URL,
    });
    expect(result.title).toBe('人工智能如何改变软件开发');
    expect(result.author).toBe('示例作者');
    expect(result.publishedAt).toBe('2025-12-20T10:35:00+08:00');
    expect(result.markdown).toContain('正文第一段');
    expect(result.markdown).toContain('子标题');
    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images).toContain(
      'https://p3-sign.toutiaoimg.com/article-cover.webp',
    );
    expect(result.quality).toBe('full');
  });

  it('§10 图集专用提取器：保留每张图的 figcaption 说明（不丢图注）', () => {
    // 站点专用提取器此前缺失，gallery 走 Readability 回退会丢失/错排图注。
    // 专用提取器应识别 data-testid="gallery-detail"，按 figure 结构保留每张图的说明。
    const html = loadFixture('gallery');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/article/gallery1/',
      originalUrl: 'https://www.toutiao.com/article/gallery1/',
    });
    expect(result.title).toBe('2025 年科技回顾图集');
    // 三张图的说明都应保留在正文
    expect(result.markdown).toContain('芯片突破');
    expect(result.markdown).toContain('火箭发射');
    expect(result.markdown).toContain('AI 模型');
    // 图片清单含全部图集图
    expect(result.images).toContain('https://p3-sign.toutiaoimg.com/g1.webp');
    expect(result.images).toContain('https://p3-sign.toutiaoimg.com/g2.webp');
    expect(result.images).toContain('https://p3-sign.toutiaoimg.com/g3.webp');
  });

  it('§10 微头条专用提取器：保留正文段落', () => {
    const html = loadFixture('short-post');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/w/micro1/',
      originalUrl: 'https://www.toutiao.com/w/micro1/',
    });
    expect(result.markdown).toContain('今天尝试用 AI 写代码');
  });

  it('marks deleted page as degraded (§12.7 已删除/失效)', () => {
    const html = loadFixture('deleted');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/article/deleted1/',
      originalUrl: 'https://www.toutiao.com/article/deleted1/',
    });
    expect(result.quality).toBe('degraded');
    expect(result.degradations.some((d) => d.code === 'content-unavailable')).toBe(true);
  });

  it('marks login-required as degraded (§12.7 付费/锁定)', () => {
    const html = loadFixture('login-required');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/article/private1/',
      originalUrl: 'https://www.toutiao.com/article/private1/',
    });
    expect(result.quality).toBe('degraded');
    expect(result.degradations.some((d) => d.code === 'partial-visibility')).toBe(true);
  });

  it('marks challenge page as degraded with challenge signal', () => {
    const html = loadFixture('challenge');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/article/challenge1/',
      originalUrl: 'https://www.toutiao.com/article/challenge1/',
    });
    expect(result.quality).toBe('degraded');
  });

  it('handles gallery (multiple figures)', () => {
    const html = loadFixture('gallery');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/article/gallery1/',
      originalUrl: 'https://www.toutiao.com/article/gallery1/',
    });
    expect(result.images.length).toBe(3);
    expect(result.markdown).toContain('芯片突破');
  });

  it('handles short-post', () => {
    const html = loadFixture('short-post');
    const result = extractDetail({
      html,
      canonicalUrl: 'https://www.toutiao.com/wenda/short1/',
      originalUrl: 'https://www.toutiao.com/wenda/short1/',
    });
    expect(result.markdown).toContain('今天尝试用 AI 写代码');
  });
});
