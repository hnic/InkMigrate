import { describe, it, expect } from 'vitest';
import { extractToutiaoContentId, canonicalizeToutiaoUrl } from '../../src/normalize/url.js';

describe('extractToutiaoContentId (§9 移动端分享短链接)', () => {
  it('标准内容路径提取数字 ID', () => {
    expect(extractToutiaoContentId('https://www.toutiao.com/article/7428193012345678901/')).toBe('7428193012345678901');
    expect(extractToutiaoContentId('https://www.toutiao.com/video/111/')).toBe('111');
    expect(extractToutiaoContentId('https://www.toutiao.com/w/222/')).toBe('222');
  });

  it('移动端 /is/<数字>/ 分享短链接提取 ID（数字 token）', () => {
    // §9：m.toutiao.com/is/<digits>/ 是常见的移动端分享短链接形式之一，
    // 其中 token 即数字内容 ID。extractToutiaoContentId 应识别并提取。
    expect(extractToutiaoContentId('https://m.toutiao.com/is/7428193012345678901/')).toBe('7428193012345678901');
  });

  it('www 子域 + /is/<数字>/ 同样识别', () => {
    expect(extractToutiaoContentId('https://www.toutiao.com/is/9988776655/')).toBe('9988776655');
  });

  it('字母数字 token 的 /is/ 短链接无法静态提取（需 HTTP 重定向解析）', () => {
    // §9：字母数字 token（如 /is/abc123xyz/）编码的是重定向目标，非直接 ID，
    // 无法用正则静态提取——需 resolveShortLink 跟随重定向。这里断言静态提取返回 undefined。
    expect(extractToutiaoContentId('https://m.toutiao.com/is/abc123xyz/')).toBeUndefined();
  });

  it('非 toutiao 域名返回 undefined', () => {
    expect(extractToutiaoContentId('https://example.com/article/123/')).toBeUndefined();
  });
});

describe('canonicalizeToutiaoUrl (回归)', () => {
  it('剥离追踪参数与 fragment', () => {
    const c = canonicalizeToutiaoUrl('https://www.toutiao.com/article/1/?utm_source=x&from=feed#top');
    expect(c).toBe('https://www.toutiao.com/article/1/');
  });
});
