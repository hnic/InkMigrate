import { describe, it, expect, vi } from 'vitest';
import {
  resolveShortLink,
  needsShortLinkResolution,
} from '../../src/normalize/short-link-resolver.js';

/** 最小化的 Page mock：实现 goto/url 即可。 */
function mockPage(finalUrl: string, gotoShouldThrow = false): {
  page: { goto: ReturnType<typeof vi.fn>; url: ReturnType<typeof vi.fn> };
  gotoCalls: string[];
} {
  const gotoCalls: string[] = [];
  const page = {
    goto: vi.fn(async (u: string) => {
      gotoCalls.push(u);
      if (gotoShouldThrow) throw new Error('timeout');
    }),
    url: vi.fn(() => finalUrl),
  };
  return { page, gotoCalls };
}

describe('needsShortLinkResolution (§9)', () => {
  it('字母数字 /is/ token 需要解析', () => {
    expect(needsShortLinkResolution('https://m.toutiao.com/is/abc123xyz/')).toBe(true);
  });
  it('纯数字 /is/ token 无需解析（可静态提取）', () => {
    expect(needsShortLinkResolution('https://m.toutiao.com/is/7428193012345678901/')).toBe(false);
  });
  it('内容原生 URL 无需解析', () => {
    expect(needsShortLinkResolution('https://www.toutiao.com/article/123/')).toBe(false);
  });
});

describe('resolveShortLink (§9)', () => {
  it('字母数字 /is/ 短链：导航后返回重定向目标（内容原生 URL）', async () => {
    const { page, gotoCalls } = mockPage('https://www.toutiao.com/article/7428193012345678901/');
    const resolved = await resolveShortLink('https://m.toutiao.com/is/abc123xyz/', { page });
    expect(resolved).toBe('https://www.toutiao.com/article/7428193012345678901/');
    expect(gotoCalls).toEqual(['https://m.toutiao.com/is/abc123xyz/']);
  });

  it('缓存命中不重复导航', async () => {
    const { page, gotoCalls } = mockPage('https://www.toutiao.com/video/99/');
    const cache = new Map<string, string>();
    const url = 'https://m.toutiao.com/is/xyz/';
    await resolveShortLink(url, { page, cache });
    await resolveShortLink(url, { page, cache });
    expect(gotoCalls.length).toBe(1); // 第二次命中缓存
  });

  it('纯数字 /is/ 与内容原生 URL 原样返回（不导航）', async () => {
    const { page, gotoCalls } = mockPage('https://www.toutiao.com/article/123/');
    const a = await resolveShortLink('https://m.toutiao.com/is/123/', { page });
    const b = await resolveShortLink('https://www.toutiao.com/article/123/', { page });
    expect(a).toBe('https://m.toutiao.com/is/123/');
    expect(b).toBe('https://www.toutiao.com/article/123/');
    expect(gotoCalls.length).toBe(0);
  });

  it('导航超时/失败时保留原 URL（不抛错，调用方按 fallback 处理）', async () => {
    const { page } = mockPage('', true);
    const resolved = await resolveShortLink('https://m.toutiao.com/is/abc/', { page });
    expect(resolved).toBe('https://m.toutiao.com/is/abc/');
  });

  it('重定向后仍是 /is/ 短链（解析失败）→ 保留原 URL', async () => {
    const { page } = mockPage('https://m.toutiao.com/is/other/');
    const resolved = await resolveShortLink('https://m.toutiao.com/is/abc/', { page });
    expect(resolved).toBe('https://m.toutiao.com/is/abc/');
  });
});
