import { describe, expect, it } from 'vitest';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractHtmlNote, scanHtmlNote } from '../src/html/html-export.js';
import { collectEnexFiles } from '../src/enex/scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_EXPORT = join(__dirname, 'fixtures', 'evernote', 'html-export');

describe('scanHtmlNote（§15.12 轻量头信息）', () => {
  it('标题取自 <title>，笔记本取自父目录，探测同名 .resources 目录', () => {
    const h = scanHtmlNote(join(HTML_EXPORT, '工作笔记本', '会议记录.html'), HTML_EXPORT);
    expect(h.title).toBe('会议记录');
    expect(h.notebook).toBe('工作笔记本');
    expect(h.resourcesDir).toBe(join(HTML_EXPORT, '工作笔记本', '会议记录.resources'));
    expect(h.relPath).toBe(join('工作笔记本', '会议记录.html'));
    expect(h.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('根层级笔记笔记本回退导出根目录名', () => {
    const h = scanHtmlNote(join(HTML_EXPORT, '剪藏.html'), HTML_EXPORT);
    expect(h.notebook).toBe('html-export');
    expect(h.resourcesDir).toBeUndefined();
  });
});

describe('extractHtmlNote（§15.12 正文/资源/链接）', () => {
  it('本地图片字节化 + 合成 URI，PDF 转附件占位，外链保留，脚本被清洗', () => {
    const r = extractHtmlNote(join(HTML_EXPORT, '工作笔记本', '会议记录.html'), HTML_EXPORT);
    // 图片与 PDF 都进 assets（fileName 为原文件名）
    const img = r.assets.find((a) => a.fileName === '白板照片.png')!;
    expect(img).toBeDefined();
    expect(img.kind).toBe('image');
    expect(img.mimeType).toBe('image/png');
    expect(img.originalUrl).toMatch(/^evernote-resource:\/\/[0-9a-f]{16}$/);
    expect(img.byteSize).toBeGreaterThan(0);
    const pdf = r.assets.find((a) => a.fileName === '议程.pdf')!;
    expect(pdf.kind).toBe('pdf');
    expect(r.resolvedResources).toBe(2);
    // 正文：图片引用改为合成 URI；PDF 锚点转附件占位；外链保留
    expect(r.bodyHtml).toContain(`src="${img.originalUrl}"`);
    expect(r.bodyHtml).toContain('📎 附件：议程.pdf');
    expect(r.bodyHtml).toContain('href="https://example.com/doc"');
    expect(r.links).toContainEqual({
      url: 'https://example.com/doc',
      text: '外部文档',
      kind: 'external',
    });
    // 清洗：脚本与事件属性被移除
    expect(r.bodyHtml).not.toContain('<script');
    expect(r.bodyHtml).not.toContain('onclick');
    expect(r.missingResources).toBe(0);
  });

  it('缺失资源引用计为 missing，远程图片保留原链接', () => {
    const r = extractHtmlNote(join(HTML_EXPORT, '剪藏.html'), HTML_EXPORT);
    expect(r.missingResources).toBe(1);
    expect(r.bodyHtml).toContain('资源缺失');
    expect(r.bodyHtml).toContain('https://example.invalid/remote.png');
    expect(r.remoteImages).toEqual([
      { url: 'https://example.invalid/remote.png', alt: '远程图' },
    ]);
    expect(r.assets).toHaveLength(0);
  });

  it('资源引用逃逸导出根按缺失处理（§15.12 路径边界）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-html-sec-'));
    try {
      mkdirSync(join(dir, 'export'), { recursive: true });
      writeFileSync(
        join(dir, 'outside.png'),
        // 1x1 PNG
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      writeFileSync(
        join(dir, 'export', 'note.html'),
        '<html><body><img src="../outside.png"></body></html>',
      );
      const r = extractHtmlNote(join(dir, 'export', 'note.html'), join(dir, 'export'));
      expect(r.missingResources).toBe(1);
      expect(r.assets).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('符号链接资源拒绝（防逃逸）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-html-symlink-'));
    try {
      mkdirSync(join(dir, 'export'), { recursive: true });
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      writeFileSync(join(dir, 'real.png'), png);
      copyFileSync(join(dir, 'real.png'), join(dir, 'export', 'direct.png'));
      try {
        symlinkSync(join(dir, 'real.png'), join(dir, 'export', 'linked.png'));
      } catch {
        return; // 平台不支持 symlink 时跳过
      }
      writeFileSync(
        join(dir, 'export', 'note.html'),
        '<html><body><img src="direct.png"><img src="linked.png"></body></html>',
      );
      const r = extractHtmlNote(join(dir, 'export', 'note.html'), join(dir, 'export'));
      // 直达文件解析成功；符号链接按缺失处理
      expect(r.assets.map((a) => a.fileName)).toEqual(['direct.png']);
      expect(r.missingResources).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectEnexFiles 的 html 收集', () => {
  it('includeHtml 时收集 .html 且跳过 .resources 目录，默认不收集', async () => {
    const withHtml = await collectEnexFiles([HTML_EXPORT], '@@@', { includeHtml: true });
    // basename 取文件名：split('/') 在 Windows（\ 分隔符）下取到整个绝对路径
    expect(withHtml.htmlFiles.map((p) => basename(p)).sort()).toEqual([
      '会议记录.html',
      '剪藏.html',
      '随笔.html',
    ]);
    const withoutHtml = await collectEnexFiles([HTML_EXPORT], '@@@');
    expect(withoutHtml.htmlFiles).toHaveLength(0);
    expect(withoutHtml.skipped.join('\n')).toContain('剪藏.html');
  });
});
