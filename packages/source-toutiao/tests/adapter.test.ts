import { describe, it, expect } from 'vitest';
import {
  createToutiaoSource,
  TOUTIAO_CAPABILITIES,
  scanFavoritesList,
  deriveFingerprintInput,
  extractDetail,
} from '../src/index.js';
import {
  computeFingerprint,
  computeStableKey,
  validateSourceItemQuality,
  type SourceAdapter,
  type SourceItem,
  type SourceItemRef,
} from '@inkmigrate/core';
import { loadFixture } from './helpers/fixtures.js';

describe('TOUTIAO_CAPABILITIES (§12.1)', () => {
  it('v1.1 declares supportsSourceCleanup=true with unfavorite action', () => {
    expect(TOUTIAO_CAPABILITIES.supportsSourceCleanup).toBe(true);
    expect(TOUTIAO_CAPABILITIES.cleanupActions).toEqual(['unfavorite']);
  });
  it('declares correct authMode and discoveryMode', () => {
    expect(TOUTIAO_CAPABILITIES.authMode).toBe('browser-profile');
    expect(TOUTIAO_CAPABILITIES.discoveryMode).toBe('remote-list');
    expect(TOUTIAO_CAPABILITIES.supportsAssets).toBe(true);
    expect(TOUTIAO_CAPABILITIES.supportsIncrementalScan).toBe(true);
  });
});

describe('createToutiaoSource (§8.2 contract)', () => {
  const source = createToutiaoSource();

  it('declares kind=toutiao and compatible api version', () => {
    expect(source.kind).toBe('toutiao');
    expect(source.adapterApiVersion).toMatch(/^1\./);
    expect(source.capabilities).toBe(TOUTIAO_CAPABILITIES);
    expect(source.cleanup).toBeDefined();
    expect(source.cleanup?.supportedActions).toEqual(['unfavorite']);
  });

  it('scan yields SourceItemRefs from favorites fixture (via inject)', async () => {
    const fixtureHtml = loadFixture('favorites-list');
    const fixtureSource = createFixtureDrivenSource(fixtureHtml);
    const refs: SourceItemRef[] = [];
    for await (const ref of fixtureSource.scan({
      config: {},
      workspaceDir: '.',
    })) {
      refs.push(ref);
    }
    expect(refs.length).toBe(3);
    expect(refs[0]!.externalId).toBe('7428193012345678901');
    expect(refs[0]!.fingerprint).toMatch(/^sha256:/);
  });

  it('extract returns a full SourceItem for article fixture', async () => {
    const html = loadFixture('article');
    const url = 'https://www.toutiao.com/article/7428193012345678901/';
    const fixtureSource = createFixtureDrivenSource('', {
      detailHtmlByUrl: { [url]: html },
    });
    const ref: SourceItemRef = {
      sourceInstanceId: 'toutiao-main',
      externalId: '7428193012345678901',
      canonicalUrl: url,
      contentKind: 'article',
      discoveredAt: '2026-06-22T14:30:00+08:00',
      fingerprint: 'sha256:' + 'a'.repeat(64),
      sourceMetadata: {},
      title: 'x',
    };
    const item = await fixtureSource.extract(ref, {
      config: {},
      workspaceDir: '.',
    });
    expect(item.quality).toBe('full');
    expect(item.title).toBe('人工智能如何改变软件开发');
    expect(item.assets.length).toBeGreaterThan(0);
  });
});

/**
 * 构造一个 fixture-driven SourceAdapter，用于在没有真实浏览器时测试 scan/extract。
 * 复用真实 createToutiaoSource 的元数据（kind/version/capabilities），只覆盖 scan/extract。
 */
function createFixtureDrivenSource(
  favoritesHtml: string,
  opts: { detailHtmlByUrl?: Record<string, string> } = {},
): SourceAdapter {
  const real = createToutiaoSource();
  return {
    ...real,
    async *scan(_ctx) {
      const result = await scanFavoritesList({
        initialHtml: favoritesHtml,
        baseUrl: 'https://www.toutiao.com/',
        scrollForMore: async () => null,
        maxEmptyCycles: 1,
      });
      for (const fav of result.items) {
        const fpBuilder: Parameters<typeof deriveFingerprintInput>[0] = {
          canonicalUrl: fav.canonicalUrl,
        };
        if (fav.externalId !== undefined) fpBuilder.contentId = fav.externalId;
        const fp = computeFingerprint(deriveFingerprintInput(fpBuilder));
        const ref: SourceItemRef = {
          sourceInstanceId: 'toutiao-main',
          canonicalUrl: fav.canonicalUrl,
          originalUrl: fav.originalUrl,
          title: fav.title,
          contentKind: fav.contentKind,
          discoveredAt: new Date().toISOString(),
          fingerprint: fp,
          sourceMetadata: fav.sourceMetadata,
        };
        if (fav.externalId !== undefined) ref.externalId = fav.externalId;
        yield ref;
      }
    },
    async extract(ref, _ctx) {
      const url = ref.canonicalUrl ?? '';
      const html = opts.detailHtmlByUrl?.[url] ?? '';
      const detail = extractDetail({
        html,
        canonicalUrl: url,
        originalUrl: url,
      });
      const degradations = detail.degradations;
      const quality = detail.quality;
      validateSourceItemQuality(quality, degradations);
      const item: SourceItem = {
        ref,
        title: detail.title,
        tags: [],
        collections: [],
        assets: detail.images.map((url, idx) => ({
          externalId: `asset-${idx}`,
          originalUrl: url,
          kind: 'image' as const,
        })),
        links: [],
        quality,
        degradations,
        extractionMethod: 'fixture',
        extractionWarnings: [],
        sourceMetadata: {},
      };
      if (detail.author !== undefined) item.author = detail.author;
      if (detail.publishedAt !== undefined) item.publishedAt = detail.publishedAt;
      if (detail.markdown) item.bodyText = detail.markdown;
      if (detail.html) item.bodyHtml = detail.html;
      return item;
    },
  };
}
