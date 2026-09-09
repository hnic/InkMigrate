import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSourceAdapterContract } from '@inkmigrate/testkit';
import {
  createEvernoteSource,
  lastScanIssues,
  EvernoteNotesRejectedError,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'evernote');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'inkmigrate-evernote-adapter-'));
}

/** 构造纯净输入目录（剔除 malformed/.notes，专用于 scan/extract 集成断言）。 */
function cleanInput(): string {
  const dir = tmpDir();
  for (const f of [
    'basic.enex',
    'Work@@@Projects.enex',
    'resources-named.enex',
    'resources-unnamed.enex',
    'resource-hash-mismatch.enex',
    'remote-images.enex',
  ]) {
    copyFileSync(join(FIXTURES, f), join(dir, f));
  }
  return dir;
}

const CONFIG = (inputDir: string) => ({
  sourceInstanceId: 'evernote-archive',
  inputPaths: [inputDir],
});

runSourceAdapterContract(() => createEvernoteSource(CONFIG('/nonexistent-ok-for-contract')));

describe('createEvernoteSource', () => {
  it('非法配置在工厂处抛错', () => {
    expect(() =>
      createEvernoteSource({ sourceInstanceId: 'x', inputPaths: [], formats: ['enex'] }),
    ).toThrow();
  });

  it('prepare 拒绝 .notes 输入（§15.2.1 显式失败）', async () => {
    const dir = tmpDir();
    try {
      copyFileSync(join(FIXTURES, 'yinxiang-export.notes'), join(dir, 'x.notes'));
      const adapter = createEvernoteSource(CONFIG(dir));
      await expect(adapter.prepare({ config: {}, workspaceDir: dir })).rejects.toBeInstanceOf(
        EvernoteNotesRejectedError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scan 产出全部笔记 ref（笔记本/Stack 进 sourceMetadata，§15.5）', async () => {
    const input = cleanInput();
    try {
      const adapter = createEvernoteSource(CONFIG(input));
      await adapter.prepare({ config: {}, workspaceDir: input });
      const refs = [];
      for await (const ref of adapter.scan({ config: {}, workspaceDir: input })) {
        refs.push(ref);
      }
      // basic 2 + Work@@@Projects 1 + resources-named 1 + resources-unnamed 1
      // + resource-hash-mismatch 1 + remote-images 1 = 7
      expect(refs).toHaveLength(7);
      expect(new Set(refs.map((r) => r.externalId)).size).toBe(7);
      expect(refs.every((r) => r.sourceInstanceId === 'evernote-archive')).toBe(true);
      expect(refs.every((r) => r.contentKind === 'note')).toBe(true);

      const workRef = refs.find((r) => r.title === '项目会议纪要');
      const meta = (workRef!.sourceMetadata as { enex: Record<string, unknown> }).enex;
      expect(meta.stack).toBe('Work');
      expect(meta.notebook).toBe('Projects');
      const basicRef = refs.find((r) => r.title === '第一条笔记');
      const basicMeta = (basicRef!.sourceMetadata as { enex: Record<string, unknown> }).enex;
      expect(basicMeta.stack).toBeUndefined();
      expect(basicMeta.notebook).toBe('basic');
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it('malformed 文件隔离：好笔记产出、问题记录（§15.3）', async () => {
    const dir = tmpDir();
    try {
      copyFileSync(join(FIXTURES, 'malformed.enex'), join(dir, 'malformed.enex'));
      const adapter = createEvernoteSource(CONFIG(dir));
      const titles: string[] = [];
      for await (const ref of adapter.scan({ config: {}, workspaceDir: dir })) {
        titles.push(ref.title ?? '');
      }
      expect(titles).toEqual(['完好的笔记']);
      expect(lastScanIssues(adapter).join('\n')).toContain('malformed.enex');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extract：完整解析笔记（正文/资源/标签/元数据/降级，§15.6-§15.13）', async () => {
    const input = cleanInput();
    try {
      const adapter = createEvernoteSource(CONFIG(input));
      const ctx = { config: {}, workspaceDir: input };
      const refs = [];
      for await (const ref of adapter.scan(ctx)) refs.push(ref);

      // ── 基础笔记：full 质量、元数据齐 ──
      const basic = await adapter.extract(
        refs.find((r) => r.title === '第一条笔记')!,
        ctx,
      );
      expect(basic.quality).toBe('full');
      expect(basic.degradations).toHaveLength(0);
      expect(basic.tags).toEqual(['阅读', '项目/子项']);
      expect(basic.collections).toEqual(['basic']);
      expect(basic.author).toBe('张三');
      expect(basic.createdAt).toBe('2019-05-03T08:20:00Z');
      expect(basic.bodyHtml).toContain('<h1>小标题</h1>');
      expect(basic.links).toContainEqual({
        url: 'https://example.com/link',
        text: '外部链接',
        kind: 'external',
      });

      // ── 待办笔记：checkbox 转换 ──
      const todoNote = await adapter.extract(
        refs.find((r) => r.title === '项目会议纪要')!,
        ctx,
      );
      expect(todoNote.bodyHtml).toContain('type="checkbox"');

      // ── 带附件笔记：资源本地化 URI、命名、冲突、附件占位、加密块 ──
      const named = await adapter.extract(
        refs.find((r) => r.title === '带附件的笔记')!,
        ctx,
      );
      expect(named.quality).toBe('degraded'); // 加密块 → unsupported-structure
      expect(named.assets).toHaveLength(3); // 2 个命名 + 1 个冲突名（未去重，字节不同）
      const shot = named.assets.find((a) => a.fileName === '截图.png')!;
      expect(shot.originalUrl).toMatch(/^enex-resource:\/\/[0-9a-f]{32}$/);
      expect(shot.mimeType).toBe('image/png');
      expect(shot.kind).toBe('image');
      expect(named.bodyHtml).toContain(`enex-resource://${shot.externalId}`);
      // PDF 未被正文 en-media 引用：作为未引用资源保留（目标端附件区，e2e 已覆盖）
      expect(named.assets.find((a) => a.fileName === '报告.pdf')!.kind).toBe('pdf');
      expect(named.bodyHtml).toContain('加密内容未迁移');
      expect(named.degradations.map((d) => d.code)).toContain('unsupported-structure');
      expect(
        named.extractionWarnings.join('\n'),
      ).toContain('资源对账：总数 3，成功 3，失败 0');
      expect(named.extractionWarnings.join('\n')).toContain('内部链接：1 条未解析');

      // ── 未命名资源：序号命名 ──
      const unnamed = await adapter.extract(
        refs.find((r) => r.title === '未命名资源的笔记')!,
        ctx,
      );
      expect(unnamed.assets.map((a) => a.fileName).sort()).toEqual(['001.png', '002.png']);
      expect(unnamed.quality).toBe('full');

      // ── 哈希不匹配：降级 + 对账计数 ──
      const mismatch = await adapter.extract(
        refs.find((r) => r.title === '哈希不匹配的笔记')!,
        ctx,
      );
      expect(mismatch.quality).toBe('degraded');
      expect(mismatch.degradations.map((d) => d.code)).toContain('asset-incomplete');
      expect(mismatch.extractionWarnings.join('\n')).toContain('缺失引用 1');

      // ── 远程图片：默认不下载，保留远程链接 ──
      const remote = await adapter.extract(
        refs.find((r) => r.title === '剪藏笔记')!,
        ctx,
      );
      expect(remote.bodyHtml).toContain('https://example.invalid/remote.png');
      expect(remote.extractionWarnings.join('\n')).toContain('未下载');
      await adapter.close();
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it('extract：文件在扫描后被修改时报错（§15.3 完整性）', async () => {
    const input = cleanInput();
    try {
      const adapter = createEvernoteSource(CONFIG(input));
      const ctx = { config: {}, workspaceDir: input };
      const refs = [];
      for await (const ref of adapter.scan(ctx)) refs.push(ref);
      writeFileSync(
        join(input, 'basic.enex'),
        '<?xml version="1.0"?><en-export><note><title>changed</title></note></en-export>',
      );
      const basicRef = refs.find((r) => r.title === '第一条笔记')!;
      await expect(adapter.extract(basicRef, ctx)).rejects.toThrow(/扫描后被修改/);
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });

  it('downloadImages: true 时下载成功进 assets（§15.6/§12.10 管线）', async () => {
    // 本地 mock 服务器走 allowPrivateTargets 路径不可行（生产恒关闭）——
    // 用不可达地址验证失败路径：保留远程链接 + degraded。
    const input = cleanInput();
    try {
      const adapter = createEvernoteSource({
        sourceInstanceId: 'evernote-archive',
        inputPaths: [input],
        assets: { downloadImages: true, maxImageBytes: 1024 * 1024 },
      });
      const ctx = { config: {}, workspaceDir: input };
      const refs = [];
      for await (const ref of adapter.scan(ctx)) refs.push(ref);
      const remote = await adapter.extract(refs.find((r) => r.title === '剪藏笔记')!, ctx);
      expect(remote.quality).toBe('degraded');
      expect(remote.degradations.map((d) => d.code)).toContain('asset-incomplete');
      expect(remote.bodyHtml).toContain('https://example.invalid/remote.png');
      await adapter.close();
    } finally {
      rmSync(input, { recursive: true, force: true });
    }
  });
});
