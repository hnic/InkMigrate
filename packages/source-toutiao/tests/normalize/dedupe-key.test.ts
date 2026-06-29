import { describe, it, expect } from 'vitest';
import { deriveDedupeKey } from '../../src/normalize/dedupe-key.js';

/**
 * §缺陷3：浏览器端去重 key 必须与 Node 端 scanner 的 key 同口径，
 * 否则同一收藏项因 href 中的 query/追踪参数差异，会被浏览器端判为"新条目"
 * 传回 Node，再被 Node 端归一化去重丢弃 → 本轮 newInThisRound=0 → 连续多轮
 * 触发 emptyCycles>=5 提前终止（扫描尚未到底）。
 *
 * Node 端 key = externalId ?? canonicalUrl，其中
 *   externalId = extractToutiaoContentId(canonicalUrl)
 *   canonicalUrl = canonicalizeToutiaoUrl(originalUrl)
 * 浏览器端必须产出同一个 key。
 */
describe('deriveDedupeKey (§缺陷3 去重口径对齐)', () => {
  it('同一文章不同追踪参数产生相同 key', () => {
    const baseUrl = 'https://www.toutiao.com/';
    const a = deriveDedupeKey(
      'https://www.toutiao.com/article/7428193012345678901/?from=search&utm_source=x',
      baseUrl,
    );
    const b = deriveDedupeKey(
      'https://www.toutiao.com/article/7428193012345678901/',
      baseUrl,
    );
    expect(a).toBe(b);
  });

  it('同一条目带 fragment 与不带 fragment 等价', () => {
    const baseUrl = 'https://www.toutiao.com/';
    const a = deriveDedupeKey(
      'https://www.toutiao.com/article/111/#comment-area',
      baseUrl,
    );
    const b = deriveDedupeKey(
      'https://www.toutiao.com/article/111/',
      baseUrl,
    );
    expect(a).toBe(b);
  });

  it('微头条 /w/ 路径也按 contentId 稳定去重', () => {
    const baseUrl = 'https://www.toutiao.com/';
    const a = deriveDedupeKey(
      'https://www.toutiao.com/w/9998887776665/?log_from=feed',
      baseUrl,
    );
    const b = deriveDedupeKey(
      'https://www.toutiao.com/w/9998887776665/',
      baseUrl,
    );
    expect(a).toBe(b);
  });

  it('不同文章 contentId 不同 → key 不同', () => {
    const baseUrl = 'https://www.toutiao.com/';
    const a = deriveDedupeKey(
      'https://www.toutiao.com/article/111/',
      baseUrl,
    );
    const b = deriveDedupeKey(
      'https://www.toutiao.com/article/222/',
      baseUrl,
    );
    expect(a).not.toBe(b);
  });

  it('key 与 Node 端 scanner 口径一致：externalId 优先（数字 contentId）', () => {
    // Node 端：key = externalId ?? canonicalUrl，externalId 提取自路径数字。
    // 因此 key 应是裸 contentId（如 "7428193012345678901"），与 href 里带不带
    // 追踪参数无关。
    const baseUrl = 'https://www.toutiao.com/';
    const key = deriveDedupeKey(
      'https://www.toutiao.com/article/7428193012345678901/?share_token=abc',
      baseUrl,
    );
    expect(key).toBe('7428193012345678901');
  });
});
