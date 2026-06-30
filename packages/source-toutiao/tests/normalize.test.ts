import { describe, it, expect } from 'vitest';
import {
  canonicalizeToutiaoUrl,
  extractToutiaoContentId,
} from '../src/normalize/url.js';
import { detectContentKind } from '../src/normalize/content-kind.js';
import { deriveFingerprintInput } from '../src/normalize/fingerprint.js';

describe('canonicalizeToutiaoUrl (§12.6)', () => {
  it('strips fragment', () => {
    expect(
      canonicalizeToutiaoUrl('https://www.toutiao.com/article/123/#comment'),
    ).toBe('https://www.toutiao.com/article/123/');
  });
  it('strips known tracking params', () => {
    expect(
      canonicalizeToutiaoUrl(
        'https://www.toutiao.com/article/123/?utm_source=x&from=feed&foo=bar',
      ),
    ).toBe('https://www.toutiao.com/article/123/?foo=bar');
  });
  it('preserves content-identity path and id', () => {
    expect(
      canonicalizeToutiaoUrl('https://www.toutiao.com/article/7428193012345678901/'),
    ).toBe('https://www.toutiao.com/article/7428193012345678901/');
  });
  it('does NOT modify image URL signature params', () => {
    const img =
      'https://p3-sign.toutiaoimg.com/x.webp?_iz=abcd&x-expires=123&x-signature=xyz';
    expect(canonicalizeToutiaoUrl(img)).toBe(img);
  });
  it('handles short-post (wenda) and video urls without throwing', () => {
    expect(() =>
      canonicalizeToutiaoUrl('https://www.toutiao.com/wenda/123/'),
    ).not.toThrow();
    expect(() =>
      canonicalizeToutiaoUrl('https://www.toutiao.com/video/123/'),
    ).not.toThrow();
  });
});

describe('extractToutiaoContentId (§12.6 priority 1)', () => {
  it('extracts id from /article/<id>/', () => {
    expect(
      extractToutiaoContentId('https://www.toutiao.com/article/7428193012345678901/'),
    ).toBe('7428193012345678901');
  });
  it('extracts id from /wenda/<id>/', () => {
    expect(extractToutiaoContentId('https://www.toutiao.com/wenda/12345/')).toBe(
      '12345',
    );
  });
  it('returns undefined for non-toutiao url', () => {
    expect(extractToutiaoContentId('https://example.com/x')).toBeUndefined();
  });
});

describe('detectContentKind (§12.7)', () => {
  it('detects article from /article/ path', () => {
    expect(
      detectContentKind({ url: 'https://www.toutiao.com/article/123/' }),
    ).toBe('article');
  });
  it('detects question-answer from /wenda/ path', () => {
    expect(
      detectContentKind({ url: 'https://www.toutiao.com/wenda/123/' }),
    ).toBe('question-answer');
  });
  it('detects video from /video/ path', () => {
    expect(
      detectContentKind({ url: 'https://www.toutiao.com/video/123/' }),
    ).toBe('video');
  });
  it('falls back to unknown when no signal', () => {
    expect(detectContentKind({})).toBe('unknown');
  });
  it('prefers explicit hint over path inference', () => {
    expect(
      detectContentKind({
        url: 'https://www.toutiao.com/article/123/',
        hint: 'gallery',
      }),
    ).toBe('gallery');
  });
});

describe('deriveFingerprintInput (§12.6 4-level priority)', () => {
  it('level 1: uses contentId when present (I2: 上层有值则不混入 canonicalUrl)', () => {
    const input = deriveFingerprintInput({
      contentId: '7428193012345678901',
      canonicalUrl: 'https://www.toutiao.com/article/7428193012345678901/',
      title: 't',
      author: 'a',
      publishedAt: '2025-12-20T10:35:00+08:00',
      originalUrl: 'https://www.toutiao.com/article/7428193012345678901/?utm=x',
    });
    expect(input.externalId).toBe('7428193012345678901');
    // I2: contentId 存在时指纹只用 contentId，不再混入 canonicalUrl，
    // 避免同一文章（一次扫到 externalId、一次没扫到）产生不同指纹 → 重复迁移。
    expect(input.canonicalUrl).toBeUndefined();
  });
  it('level 2: falls back to canonicalUrl when no contentId', () => {
    const input = deriveFingerprintInput({
      canonicalUrl: 'https://www.toutiao.com/article/abc/',
      title: 't',
    });
    expect(input.externalId).toBeUndefined();
    expect(input.canonicalUrl).toBe('https://www.toutiao.com/article/abc/');
  });
  it('level 3: uses title+author+publishedAt when no url', () => {
    const input = deriveFingerprintInput({
      title: '标题',
      author: '作者',
      publishedAt: '2025-12-20T10:35:00+08:00',
    });
    expect(input.title).toBe('标题');
    expect(input.author).toBe('作者');
    expect(input.publishedAt).toBe('2025-12-20T10:35:00+08:00');
    expect(input.canonicalUrl).toBeUndefined();
  });
  it('level 4: uses raw as last resort', () => {
    const input = deriveFingerprintInput({
      originalUrl: 'https://random.example/x',
    });
    expect(input.raw).toBe('https://random.example/x');
  });
});
