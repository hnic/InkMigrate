import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// vi.mock 必须在 import 前。mock extractDetail 返回固定 images 清单，
// mock downloadImage 返回固定字节，从而隔离浏览器与网络，专注于验证
// extract-driver 是否把 dl.bytes 填进 asset.data。

const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const FAKE_SHA = createHash('sha256').update(FAKE_PNG).digest('hex');

const mockDownloadImage = vi.fn();
const mockExtractDetail = vi.fn();

vi.mock('../src/extract/detail-extractor.js', () => ({
  extractDetail: (...args: unknown[]) => mockExtractDetail(...args),
}));
vi.mock('../src/assets/image-downloader.js', () => ({
  downloadImage: (...args: unknown[]) => mockDownloadImage(...args),
}));

// extract-driver 还 import validateSourceItemQuality，走真实实现即可。

const { driveExtractDetail } = await import('../src/browser/extract-driver.js');

describe('driveExtractDetail — asset.data 瞬态字节保留（§13.7）', () => {
  beforeEach(() => {
    mockDownloadImage.mockReset();
    mockExtractDetail.mockReset();
  });

  it('下载成功时把 dl.bytes 填进 asset.data', async () => {
    mockExtractDetail.mockReturnValue({
      title: '测试标题',
      quality: 'full',
      degradations: [],
      images: ['https://img.example.com/a.png'],
      html: '<p>x</p>',
      markdown: 'x',
    });
    mockDownloadImage.mockResolvedValue({
      ok: true,
      bytes: FAKE_PNG,
      mimeType: 'image/png',
      byteSize: FAKE_PNG.length,
    });

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><p>x</p></body></html>'),
    };

    const item = await driveExtractDetail({
      // @ts-expect-error mock page 只需用到的几个方法
      page,
      ref: {
        sourceInstanceId: 'toutiao-main',
        canonicalUrl: 'https://www.toutiao.com/article/1/',
        originalUrl: 'https://www.toutiao.com/article/1/',
        contentKind: 'article',
        discoveredAt: '2026-06-24T10:00:00+08:00',
        fingerprint: 'sha256:' + 'a'.repeat(64),
        sourceMetadata: {},
      },
    });

    expect(item.assets.length).toBe(1);
    const asset = item.assets[0]!;
    expect(asset.data).toBeDefined();
    expect(asset.data).toBeInstanceOf(Uint8Array);
    // 字节内容与下载的一致
    expect(Buffer.from(asset.data!)).toEqual(FAKE_PNG);
    // sha256 也正确填充（来自同一份字节）
    expect(asset.sha256).toBe(`sha256:${FAKE_SHA}`);
    expect(asset.mimeType).toBe('image/png');
  });

  it('下载失败时不填 data，asset 仅保留 originalUrl（metadata-only）', async () => {
    mockExtractDetail.mockReturnValue({
      title: '测试标题',
      quality: 'full',
      degradations: [],
      images: ['https://img.example.com/failed.png'],
      html: '<p>x</p>',
      markdown: 'x',
    });
    mockDownloadImage.mockResolvedValue({
      ok: false,
      reason: 'http 403',
      httpStatus: 403,
    });

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue('<html><body><p>x</p></body></html>'),
    };

    const item = await driveExtractDetail({
      // @ts-expect-error mock page 只需用到的几个方法
      page,
      ref: {
        sourceInstanceId: 'toutiao-main',
        canonicalUrl: 'https://www.toutiao.com/article/1/',
        originalUrl: 'https://www.toutiao.com/article/1/',
        contentKind: 'article',
        discoveredAt: '2026-06-24T10:00:00+08:00',
        fingerprint: 'sha256:' + 'a'.repeat(64),
        sourceMetadata: {},
      },
    });

    expect(item.assets.length).toBe(1);
    const asset = item.assets[0]!;
    expect(asset.data).toBeUndefined();
    expect(asset.sha256).toBeUndefined();
    expect(asset.originalUrl).toBe('https://img.example.com/failed.png');
  });
});
