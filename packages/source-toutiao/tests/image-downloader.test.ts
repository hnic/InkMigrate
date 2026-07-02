import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// 最小 PNG（1x1 透明）的 Magic Bytes
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// 最小 JPEG magic bytes（FFD8FF + E0 JFIF 标记 + 少量填充）
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_BYTES);
    } else if (url === '/ok.jpg') {
      // R4-C3: image/jpg（非标准别名）+ 合法 JPEG magic bytes
      res.writeHead(200, { 'content-type': 'image/jpg' });
      res.end(JPEG_BYTES);
    } else if (url === '/zero.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    } else if (url === '/html-as-image.png') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>error page</body></html>');
    } else if (url === '/too-big.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.alloc(10000));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('downloadImage (§12.10)', () => {
  it('downloads a valid PNG with correct magic bytes', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/ok.png`,
      maxBytes: 1024 * 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.slice(0, 8)).toEqual(PNG_BYTES.slice(0, 8));
      expect(result.mimeType).toBe('image/png');
      expect(result.byteSize).toBe(PNG_BYTES.length);
    }
  });

  it('R4-C3: accepts image/jpg content-type with JPEG magic bytes（非标准别名豁免）', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/ok.jpg`,
      maxBytes: 1024 * 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.slice(0, 3)).toEqual(JPEG_BYTES.slice(0, 3));
    }
  });

  it('rejects zero-byte response', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/zero.png`,
      maxBytes: 1024 * 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/empty|zero/i);
    }
  });

  it('rejects HTML content-type (anti error-page-as-image)', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/html-as-image.png`,
      maxBytes: 1024 * 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/content.?type|mime/i);
    }
  });

  it('enforces maxBytes during streaming', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/too-big.png`,
      maxBytes: 1000,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/size|max|too/i);
    }
  });

  it('rejects HTTP error status', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    const result = await downloadImage({
      url: `${baseUrl}/missing.png`,
      maxBytes: 1024 * 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/status|404|http/i);
    }
  });

  it('C7: blocks SSRF to loopback / private / cloud-metadata targets', async () => {
    const { downloadImage } = await import('../src/assets/image-downloader.js');
    // 生产默认（allowPrivateTargets 不传）应拒绝指向内网/元数据的 URL
    for (const evil of [
      'http://127.0.0.1:1/x.png', // loopback
      'http://169.254.169.254/latest/meta-data/iam/x', // AWS metadata
      'http://10.0.0.1/x.png', // private
    ]) {
      const result = await downloadImage({ url: evil, maxBytes: 1024 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/ssrf|private|loopback|metadata/i);
      }
    }
  });
});
