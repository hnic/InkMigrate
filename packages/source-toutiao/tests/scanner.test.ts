import { describe, it, expect } from 'vitest';
import { scanFavoritesList } from '../src/scan/scanner.js';
import { loadFixture } from './helpers/fixtures.js';

describe('scanFavoritesList (§12.4 DOM + §12.5 dedupe)', () => {
  it('extracts all favorite items from fixture', async () => {
    const html = loadFixture('favorites-list');
    const result = await scanFavoritesList({
      initialHtml: html,
      baseUrl: 'https://www.toutiao.com/',
      scrollForMore: async () => undefined,
      maxEmptyCycles: 5,
    });
    expect(result.items.length).toBe(3);
    const first = result.items[0]!;
    expect(first.externalId).toBe('7428193012345678901');
    expect(first.title).toBe('人工智能如何改变软件开发');
    expect(first.author).toBe('示例作者');
    expect(first.canonicalUrl).toBe(
      'https://www.toutiao.com/article/7428193012345678901/',
    );
    expect(first.collections).toEqual(['技术收藏']);
    expect(first.contentKind).toBe('article');
    const video = result.items.find(
      (i: { externalId?: string }) => i.externalId === '7428193012345678903',
    )!;
    expect(video.contentKind).toBe('video');
  });

  it('dedupes items across scroll cycles (§12.5 global unique set)', async () => {
    const html = loadFixture('favorites-list');
    let calls = 0;
    const result = await scanFavoritesList({
      initialHtml: html,
      baseUrl: 'https://www.toutiao.com/',
      scrollForMore: async () => {
        calls++;
        return calls === 1 ? html : '<div></div>';
      },
      // 用 1 让"第二轮重复 + 第三轮空"就触发终止
      maxEmptyCycles: 1,
    });
    expect(result.items.length).toBe(3);
    expect(result.duplicateObservations).toBe(3);
    // initial(0) + 1st scroll(重复,emptyCycles=1) + 2nd scroll(空,emptyCycles=2→终止)
    // 但 maxEmptyCycles=1 时，1st scroll 的重复就触发了 emptyCycles=1 → 下一轮直接终止
    expect(result.scrollIterations).toBeGreaterThanOrEqual(1);
  });

  it('terminates after maxEmptyCycles with no new items', async () => {
    const html = loadFixture('favorites-list');
    const result = await scanFavoritesList({
      initialHtml: html,
      baseUrl: 'https://www.toutiao.com/',
      scrollForMore: async () => null,
      maxEmptyCycles: 2,
    });
    expect(result.terminationReason).toMatch(/no_new_items|no_load_more/);
  });

  it('normalizes collection names into SourceItem.collections', async () => {
    const html = loadFixture('favorites-list');
    const result = await scanFavoritesList({
      initialHtml: html,
      baseUrl: 'https://www.toutiao.com/',
      scrollForMore: async () => undefined,
      maxEmptyCycles: 5,
    });
    const collections = new Set(
      result.items.flatMap((i: { collections: string[] }) => i.collections),
    );
    expect(collections.has('技术收藏')).toBe(true);
    expect(collections.has('随笔')).toBe(true);
  });
});
