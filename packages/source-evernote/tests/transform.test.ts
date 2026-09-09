import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assetKindOf,
  decodeBase64Strict,
  enexResourceUri,
  extForMime,
  processResources,
  sniffMime,
} from '../src/resources/process-resources.js';
import type { RawResource } from '../src/enex/sax-notes.js';
import { enmlToHtml } from '../src/enml/enml-to-html.js';

// 与 scripts/gen-fixtures.mjs 同源的 1x1 PNG（红）
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG_MD5 = md5(PNG_RED);
const PNG_BLUE_MD5 = md5(PNG_BLUE);

function rawResource(p: Partial<RawResource>): RawResource {
  return { dataBase64: PNG_RED.toString('base64'), mime: 'image/png', ...p };
}

describe('decodeBase64Strict（§15.7.3）', () => {
  it('接受含折行空白的合法 base64', () => {
    const wrapped = PNG_RED.toString('base64').replace(/(.{20})/g, '$1\n');
    const r = decodeBase64Strict(wrapped);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Buffer.compare(r.bytes, PNG_RED)).toBe(0);
  });
  it('拒绝非法字符与错误长度', () => {
    expect(decodeBase64Strict('a!b=').ok).toBe(false);
    expect(decodeBase64Strict('abc').ok).toBe(false);
    expect(decodeBase64Strict('').ok).toBe(false);
  });
});

describe('sniffMime / kind / ext（§15.7.3）', () => {
  it('识别常见魔数', () => {
    expect(sniffMime(PNG_RED)).toBe('image/png');
    expect(sniffMime(Buffer.from('%PDF-1.4'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('plain text'))).toBeNull();
  });
  it('kind 与扩展名映射', () => {
    expect(assetKindOf('application/pdf')).toBe('pdf');
    expect(assetKindOf('application/msword')).toBe('office');
    expect(assetKindOf('video/mp4')).toBe('video');
    expect(assetKindOf('application/x-unknown')).toBe('other');
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('application/x-unknown')).toBe('bin');
  });
});

describe('processResources（§15.7.4 命名链 / §15.7.6 去重）', () => {
  it('命名优先 file-name，扩展名以实际字节为准', () => {
    const { resources } = processResources(
      // 声明 MIME 与文件名都是 jpeg，但字节是 PNG：以字节为准改名 + MIME 不一致告警
      [rawResource({ fileName: '照片.jpeg', mime: 'image/jpeg' })],
      { maxResourceBytes: 1024 },
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]!.fileName).toBe('照片.png');
    expect(resources[0]!.mimeMismatch).toBe(true);
    expect(resources[0]!.asset.mimeType).toBe('image/png');
    expect(resources[0]!.asset.kind).toBe('image');
  });

  it('file-name 缺失时按序号命名', () => {
    const { resources } = processResources(
      [rawResource({}), rawResource({ dataBase64: PNG_BLUE.toString('base64') })],
      { maxResourceBytes: 1024 },
    );
    expect(resources.map((r) => r.fileName)).toEqual(['001.png', '002.png']);
  });

  it('同名冲突追加 SHA-256 前 8 位', () => {
    const { resources } = processResources(
      [
        rawResource({ fileName: '截图.png' }),
        rawResource({ dataBase64: PNG_BLUE.toString('base64'), fileName: '截图.png' }),
      ],
      { maxResourceBytes: 1024 },
    );
    expect(resources[0]!.fileName).toBe('截图.png');
    expect(resources[1]!.fileName).toBe(`截图-${sha256(PNG_BLUE).slice(0, 8)}.png`);
  });

  it('同笔记内相同内容去重，MD5/SHA-256/enex-resource URI 正确', () => {
    const { resources, duplicates } = processResources(
      [rawResource({ fileName: 'a.png' }), rawResource({ fileName: 'a.png' })],
      { maxResourceBytes: 1024 },
    );
    expect(resources).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(resources[0]!.md5Hex).toBe(PNG_MD5);
    expect(resources[0]!.asset.sha256).toBe(`sha256:${sha256(PNG_RED)}`);
    expect(resources[0]!.asset.originalUrl).toBe(enexResourceUri(PNG_MD5));
    expect(resources[0]!.asset.data).toBeDefined();
  });

  it('零字节、超限资源计为失败不进清单', () => {
    const { failures } = processResources(
      [
        rawResource({ dataBase64: '' }),
        rawResource({ dataBase64: 'A'.repeat(1400) }), // 解码约 1050B > 1024B 上限
      ],
      { maxResourceBytes: 1024 },
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]!.reason).toContain('empty');
    expect(failures[1]!.reason).toContain('exceeds');
  });
});

describe('enmlToHtml（§15.6）', () => {
  const ENML = (inner: string) =>
    `<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${inner}</en-note>`;
  const resourceMap = new Map([
    [PNG_MD5, { kind: 'image' as const, fileName: '截图.png', attachment: false }],
    [
      'f'.repeat(32),
      { kind: 'pdf' as const, fileName: '报告.pdf', attachment: true },
    ],
  ]);

  it('en-media 图片转 enex-resource img（与 asset.originalUrl 同值）', () => {
    const r = enmlToHtml(
      ENML(`<div>文本</div><en-media type="image/png" hash="${PNG_MD5}" alt="替代"/>`),
      resourceMap,
    );
    expect(r.html).toContain(`src="enex-resource://${PNG_MD5}"`);
    expect(r.html).toContain('alt="替代"');
    expect(r.missingMediaHashes).toHaveLength(0);
  });

  it('非内联类型转为附件引用占位', () => {
    const r = enmlToHtml(ENML(`<en-media type="application/pdf" hash="${'f'.repeat(32)}"/>`), resourceMap);
    expect(r.html).toContain('📎 附件：报告.pdf');
    expect(r.html).not.toContain('enex-resource');
  });

  it('资源缺失或非法哈希时保留占位并记录（§15.7.5）', () => {
    const r = enmlToHtml(ENML('<en-media type="image/png" hash="abc"/>'), resourceMap);
    expect(r.missingMediaHashes).toEqual(['abc']);
    expect(r.html).toContain('资源缺失');
  });

  it('en-crypt 转占位块并保留元数据（§15.11）', () => {
    const r = enmlToHtml(
      ENML('<en-crypt hint="银行密码" cipher="RC2" length="64">YWJj</en-crypt>'),
      new Map(),
    );
    expect(r.cryptBlocks).toEqual([{ hint: '银行密码', cipher: 'RC2', length: '64' }]);
    expect(r.html).toContain('加密内容未迁移');
    expect(r.html).toContain('data-cipher="RC2"');
  });

  it('en-todo 转 checkbox 且外层 div 归组为列表', () => {
    const r = enmlToHtml(
      ENML('<div><en-todo checked="true"/>已完成</div><div><en-todo/>待办</div>'),
      new Map(),
    );
    expect(r.todoCount).toBe(2);
    expect(r.html).toContain('<input type="checkbox" disabled="" checked="">');
    expect(r.html).toContain('<ul');
    expect(r.html).toContain('<li>');
  });

  it('收集内部/外部链接与远程图片（§15.10/§15.6）', () => {
    const r = enmlToHtml(
      ENML(
        '<div><a href="https://example.com/x">外链</a><a href="evernote:///view/1/s1/g/g/">内链</a></div>' +
          '<img src="https://cdn.example.invalid/a.png" alt="远程"/>',
      ),
      new Map(),
    );
    expect(r.externalLinks).toEqual([{ url: 'https://example.com/x', text: '外链' }]);
    expect(r.internalLinks).toEqual([
      { url: 'evernote:///view/1/s1/g/g/', text: '内链' },
    ]);
    expect(r.remoteImages).toEqual([{ url: 'https://cdn.example.invalid/a.png', alt: '远程' }]);
    expect(r.html).toContain('href="https://example.com/x"');
    expect(r.html).toContain('href="evernote:///view/1/s1/g/g/"');
  });

  it('清洗脚本与事件属性（不可信输入，§15.6）', () => {
    const r = enmlToHtml(
      ENML('<div onclick="evil()">x<script>alert(1)</script></div><img src="javascript:alert(1)"/>'),
      new Map(),
    );
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('onclick');
    expect(r.html).not.toContain('javascript:');
  });
});
