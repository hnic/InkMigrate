import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { downloadImage } from '../../src/assets/image-downloader.js';

/**
 * #280/#283-#285 行为固化：确定性失败不退避重试、重定向链畸形/超限的
 * 非重试分类、magic bytes 长度守卫与 GIF 版本字段、IPv4 保留段拦截。
 * （source-toutiao 的同名测试经兼容导出绑定 core 的 dist 构建，无法覆盖
 * core src 的最新行为，故在 core 内维护这组最小用例。）
 */
describe('downloadImage 行为契约（core 侧）', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/truncated-gif') {
        // 只有 'GIF8' 4 字节：版本字段（87a/89a）缺失
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from([0x47, 0x49, 0x46, 0x38]));
      } else if (url === '/gif89a') {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from('GIF89a,,,,'));
      } else if (url === '/gif87a') {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from('GIF87a,,,,'));
      } else if (url === '/truncated-jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Buffer.from([0xff, 0xd8, 0xff]));
      } else if (url === '/too-big') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.alloc(10000));
      } else if (url === '/bad-location') {
        // 畸形 Location：new URL() 抛错，应判确定性失败而非可重试网络错误
        res.writeHead(302, { location: 'http://%' });
        res.end();
      } else if (url.startsWith('/hop')) {
        const n = Number(url.slice('/hop'.length));
        if (n <= 6) {
          res.writeHead(302, { location: `/hop${n + 1}` });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('unreachable');
        }
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('接受带合法版本字段的 GIF87a/GIF89a', async () => {
    for (const p of ['/gif89a', '/gif87a']) {
      const result = await downloadImage({
        url: `${baseUrl}${p}`,
        maxBytes: 1024,
        allowPrivateTargets: true,
      });
      expect(result.ok, p).toBe(true);
    }
  });

  it('拒绝截断的 4 字节 GIF8（版本字段缺失）且为确定性失败', async () => {
    const result = await downloadImage({
      url: `${baseUrl}/truncated-gif`,
      maxBytes: 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/magic bytes/i);
      expect(result.deterministic).toBe(true);
    }
  });

  it('拒绝 3 字节截断的 JPEG 头', async () => {
    const result = await downloadImage({
      url: `${baseUrl}/truncated-jpg`,
      maxBytes: 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/magic bytes/i);
      expect(result.deterministic).toBe(true);
    }
  });

  it('大小超限标记 deterministic（同样字节重试不可能成功）', async () => {
    const result = await downloadImage({
      url: `${baseUrl}/too-big`,
      maxBytes: 1000,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds maxBytes/);
      expect(result.deterministic).toBe(true);
    }
  });

  it('畸形 Location 重定向归类为确定性失败而非网络错误', async () => {
    const result = await downloadImage({
      url: `${baseUrl}/bad-location`,
      maxBytes: 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/malformed redirect/i);
      expect(result.deterministic).toBe(true);
    }
  });

  it('重定向超过 5 跳上限时停止并标记确定性失败', async () => {
    const result = await downloadImage({
      url: `${baseUrl}/hop1`,
      maxBytes: 1024,
      allowPrivateTargets: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/too many redirects/i);
      expect(result.deterministic).toBe(true);
    }
  });

  it('#280 拦截 IPv4 保留段（240.0.0.0/4）字面量目标', async () => {
    const result = await downloadImage({
      url: 'http://240.1.2.3/x.png',
      maxBytes: 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/ssrf|private/i);
      expect(result.deterministic).toBe(true);
    }
  });
});
