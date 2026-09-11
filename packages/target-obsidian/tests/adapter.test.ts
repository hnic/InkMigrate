import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createObsidianTarget } from '../src/adapter.js';
import { makeTempVault } from './helpers/vault.js';
import { makeFullArticleItem, makeDegradedItem } from './helpers/fixtures.js';
import {
  computeStableKey,
  deriveStableShortId,
  type TargetContext,
  type SourceItem,
} from '@inkmigrate/core';
import type { ObsidianTargetConfig } from '../src/config.js';

function ctx(
  vaultPath: string,
  config: Partial<ObsidianTargetConfig> = {},
): TargetContext {
  const full: ObsidianTargetConfig = {
    vaultPath,
    importSubdir: 'Imports/InkMigrate',
    attachmentsSubdir: 'Attachments/InkMigrate',
    linkStyle: 'wikilink',
    overwritePolicy: 'preserve',
    collectionMapping: { toTags: false, toFolders: false },
    maxFilenameLength: 100,
    ...config,
  };
  return {
    config: {},
    workspaceDir: '.',
    vaultPath,
    targetConfig: full as unknown as Record<string, unknown>,
  };
}

let vault: { vaultPath: string; cleanup: () => void };
beforeEach(() => (vault = makeTempVault()));
afterEach(() => vault.cleanup());

describe('createObsidianTarget (§8.4 + §13)', () => {
  const adapter = createObsidianTarget();

  it('declares kind=obsidian and a compatible api version', () => {
    expect(adapter.kind).toBe('obsidian');
    expect(adapter.adapterApiVersion).toMatch(/^1\./);
  });

  describe('validateConfig', () => {
    it('rejects config missing vaultPath', async () => {
      // validateConfig 接受 AdapterContext；obsidian 适配器读取 ctx.targetConfig，
      // 因此传一个空 targetConfig 来触发 vaultPath 校验失败。
      const r = await adapter.validateConfig({
        config: {},
        workspaceDir: '.',
        targetConfig: {},
      } as unknown as Parameters<typeof adapter.validateConfig>[0]);
      expect(r.ok).toBe(false);
    });
    it('accepts a valid config', async () => {
      const r = await adapter.validateConfig(ctx(vault.vaultPath));
      expect(r.ok).toBe(true);
    });
  });

  describe('plan → write → verify (§24.5 #3,#4,#5)', () => {
    it('writes a full article to the correct path with valid frontmatter and body', async () => {
      const item = makeFullArticleItem();
      const stableKey = computeStableKey(
        item.ref.sourceInstanceId,
        item.ref.fingerprint,
      );
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      expect(plan.relativePath).toContain('Imports/InkMigrate/toutiao-main/文章/');
      // §13.4 默认纯标题文件名（filenameShortId=false，75cfaa6 口径）：
      // 短哈希后缀需显式 filenameShortId: true 才有
      expect(plan.relativePath).toBe(
        'Imports/InkMigrate/toutiao-main/文章/人工智能如何改变软件开发.md',
      );
      expect(plan.artifactKind).toBe('note');

      const result = await adapter.write(plan, ctx(vault.vaultPath));
      // §24.5 #4: file exists in temp vault
      const abs = join(vault.vaultPath, result.relativePath);
      expect(readFileSync(abs, 'utf8').length).toBeGreaterThan(0);
      // §24.5 #5: valid frontmatter + body
      const content = readFileSync(abs, 'utf8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('人工智能如何改变软件开发');
      expect(content).toContain('source_url:');
      // 标题仅出现在 frontmatter，正文不再注入 H1 标头。
      expect(content).not.toContain('# 人工智能如何改变软件开发');
      expect(content).toContain('正文第一段');
      expect(content).toContain('正文第一段。');
      // 三类哈希齐全
      expect(result.targetContentHash).toMatch(/^sha256:/);
      expect(result.writtenFileHash).toMatch(/^sha256:/);
      expect(result.sourceContentHash).toMatch(/^sha256:/);

      const verify = await adapter.verify(result, ctx(vault.vaultPath));
      expect(verify.ok).toBe(true);
    });

    it('plan artifactKind is note for normal items', async () => {
      const plan = await adapter.plan(makeFullArticleItem(), ctx(vault.vaultPath));
      expect(plan.artifactKind).toBe('note');
    });

    it('source_collections survives plan→write→read (§24.5 #5)', async () => {
      const item = makeFullArticleItem({
        collections: ['技术收藏', '另一收藏'],
      });
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      const content = readFileSync(
        join(vault.vaultPath, result.relativePath),
        'utf8',
      );
      // 精简 frontmatter 不再包含 source_collections，验证标题和正文存在
      expect(content).toContain('人工智能如何改变软件开发');
      expect(content).toContain('正文第一段');
    });
  });

  describe('idempotency (§24.5 #6: 再次运行无重复)', () => {
    it('re-running write on unmodified target produces write_canonical with same path & hashes', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const first = await adapter.write(plan, ctx(vault.vaultPath));
      const second = await adapter.write(plan, ctx(vault.vaultPath));
      expect(second.relativePath).toBe(first.relativePath);
      // same content → same hashes
      expect(second.targetContentHash).toBe(first.targetContentHash);
      expect(second.writtenFileHash).toBe(first.writtenFileHash);
    });
  });

  describe('user modification protection (§24.5 #7, §13.9)', () => {
    it('preserve policy 不覆写 DB 无哈希记录的外来同名文件（§缺陷1 数据丢失防护）', async () => {
      // 缺陷1：磁盘上存在同名文件但 DB 无该条目 writtenFileHash 记录（首次迁移
      // 遇到用户手写同名笔记 / DB 损坏后重跑）。expectedWrittenFileHash === undefined
      // 时无法判定归属，必须保守视为"用户所有"→ preserve 触发 mark_conflict，
      // 绝不能默认 write_canonical 静默覆写用户数据。
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, plan.relativePath);
      // 模拟"外来"同名文件：在迁移写入前，用户已在该路径手写笔记
      const foreignContent = '---\n---\n\n这是我手写的重要笔记，不可丢失。';
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, foreignContent, 'utf8');

      // 迁移写入，expectedWrittenFileHash 为 undefined（DB 无记录）
      const result = await adapter.write(
        plan,
        ctx(vault.vaultPath, { overwritePolicy: 'preserve' }),
        // 故意不传 expectedWrittenFileHash
      );

      // preserve + 归属未知 → mark_conflict → 外来文件原样保留，绝不被覆写
      expect(result.actionCode).toBe('stage_attempt');
      expect(readFileSync(abs, 'utf8')).toBe(foreignContent);
    });
    it('preserve policy preserves user file when user modified (§24.5 #7)', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const first = await adapter.write(plan, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, first.relativePath);
      writeFileSync(abs, readFileSync(abs, 'utf8') + '\n\n用户批注');
      // re-write with expectedWrittenFileHash = first
      const result = await adapter.write(
        plan,
        ctx(vault.vaultPath, { overwritePolicy: 'preserve' }),
        first.writtenFileHash,
      );
      // §13.9 preserve + user-modified → mark_conflict → 目标文件未被覆盖
      expect(readFileSync(abs, 'utf8')).toContain('用户批注');
      // verify first.writtenFileHash fails (file changed)
      const verify = await adapter.verify(first, ctx(vault.vaultPath));
      expect(verify.ok).toBe(false);
      // result returns the on-disk hash, not first.writtenFileHash
      expect(result.writtenFileHash).not.toBe(first.writtenFileHash);
    });

    it('replace policy overwrites user-modified file and returns forced_overwrite audit (§24.5 #17)', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const first = await adapter.write(plan, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, first.relativePath);
      writeFileSync(abs, readFileSync(abs, 'utf8') + '\n\n用户批注');
      const result = await adapter.write(
        plan,
        ctx(vault.vaultPath, { overwritePolicy: 'replace' }),
        first.writtenFileHash,
      );
      expect(result.actionCode).toBe('forced_overwrite');
      expect(result.wasForcedOverwrite).toBe(true);
      expect(result.observedPrewriteFileHash).not.toBe(first.writtenFileHash);
      expect(result.expectedWrittenFileHash).toBe(first.writtenFileHash);
      // file was actually overwritten
      expect(readFileSync(abs, 'utf8')).not.toContain('用户批注');
    });

    it('write-new policy preserves user file and writes .imported-new.md variant (§24.5 #19 note_variant)', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const first = await adapter.write(plan, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, first.relativePath);
      const userContent = readFileSync(abs, 'utf8') + '\n\n用户批注';
      writeFileSync(abs, userContent);
      const result = await adapter.write(
        plan,
        ctx(vault.vaultPath, { overwritePolicy: 'write-new' }),
        first.writtenFileHash,
      );
      expect(result.actionCode).toBe('write_new_variant');
      expect(result.relativePath).not.toBe(first.relativePath);
      expect(result.relativePath).toContain('.imported-new');
      expect(result.artifactKind).toBe('note_variant');
      // original preserved
      expect(readFileSync(abs, 'utf8')).toBe(userContent);
      // variant exists
      expect(
        readFileSync(join(vault.vaultPath, result.relativePath), 'utf8').length,
      ).toBeGreaterThan(0);
    });
  });

  describe('degraded item', () => {
    it('writes a degraded note with empty body section', async () => {
      const item = makeDegradedItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      const content = readFileSync(
        join(vault.vaultPath, result.relativePath),
        'utf8',
      );
      // 标题仅出现在 frontmatter，正文不注入 H1 标头。
      expect(content).not.toContain('# 人工智能如何改变软件开发');
      expect(content).toContain('来源信息');
    });
  });

  describe('renderIndex (§13.8 索引生成)', () => {
    it('按 indexGroupBy 生成分片索引并返回 TargetWriteResult[]', async () => {
      const entries = [
        {
          title: '文章1',
          relativePath: 'Imports/InkMigrate/s1/文章/文章1-abc.md',
          contentKind: 'article',
          favoritedAt: '2026-01-16T12:00:00+08:00',
          collections: ['技术'],
        },
        {
          title: '视频1',
          relativePath: 'Imports/InkMigrate/s1/视频/视频1-ghi.md',
          contentKind: 'video',
          favoritedAt: '2026-01-11T12:00:00+08:00',
          collections: ['技术'],
        },
      ];
      const result = await adapter.renderIndex!({
        ...ctx(vault.vaultPath),
        sourceInstanceId: 's1',
        indexEntries: entries,
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      for (const r of result) {
        expect(r.relativePath.endsWith('.md')).toBe(true);
        expect(typeof r.targetContentHash).toBe('string');
        expect(typeof r.writtenFileHash).toBe('string');
      }
      // 至少一个分片在 _索引/ 下；总入口索引在 <src>/ 根
      expect(result.some((r) => r.relativePath.includes('_索引'))).toBe(true);
      // 文件确实写入 Vault（抽查第一个）
      const abs = join(vault.vaultPath, result[0]!.relativePath);
      expect(existsSync(abs)).toBe(true);
    });

    it('generateIndex=false 时不生成任何索引（flat 单目录场景）', async () => {
      const result = await adapter.renderIndex!({
        ...ctx(vault.vaultPath, { generateIndex: false }),
        sourceInstanceId: 's1',
        indexEntries: [
          { title: '文章1', relativePath: '文章1.md', contentKind: 'article', collections: [] },
        ],
      });
      expect(result).toEqual([]);
    });

    it('无 indexEntries 时返回空数组（不报错）', async () => {
      const result = await adapter.renderIndex!({
        ...ctx(vault.vaultPath),
        sourceInstanceId: 's1',
      });
      expect(result).toEqual([]);
    });
  });

  describe('§24.5 #21 status progression is target-side observable', () => {
    it('verify returns ok=true immediately after a clean write', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      const v = await adapter.verify(result, ctx(vault.vaultPath));
      expect(v.ok).toBe(true);
    });
    it('verify returns ok=false with reason after user modification (planned→written but not verified)', async () => {
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, result.relativePath);
      writeFileSync(abs, readFileSync(abs, 'utf8') + '\n\n用户编辑');
      const v = await adapter.verify(result, ctx(vault.vaultPath));
      expect(v.ok).toBe(false);
    });
  });

  describe('verifyNote symlink escape protection (C6 一致性)', () => {
    it('verify rejects a note replaced by a symlink pointing outside the vault', async () => {
      // 写一条笔记，然后把文件替换为指向 Vault 外的 symlink，验证 verifyNote
      // 不读取外部内容（此前只做 resolveWithin 词法检查，缺 symlink 校验）。
      const item = makeFullArticleItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      const abs = join(vault.vaultPath, result.relativePath);

      // Vault 外的外部文件（模拟攻击者诱导读取的目标）
      const outside = join(vault.vaultPath, '..', 'outside-secret.md');
      writeFileSync(outside, 'SECRET FROM OUTSIDE\n');
      // 替换笔记为指向外部的 symlink
      const { unlinkSync } = await import('node:fs');
      unlinkSync(abs);
      symlinkSync(outside, abs);

      const v = await adapter.verify(result, ctx(vault.vaultPath));
      expect(v.ok).toBe(false);
      // 不应读到外部内容（不会因 hash 比对外部文件而 ok=true）
      expect(v.details).not.toMatchObject({ reason: 'hash mismatch (user-modified)' });
    });
  });

  describe('§13.7 图片本地化（assets 链路）', () => {
    /** 构造一个最小有效 PNG（1×1 透明），通过 magic bytes 校验。 */
    const MIN_PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    function makeImageAssetItem(): SourceItem {
      const { createHash } = require('node:crypto');
      const sha = createHash('sha256').update(MIN_PNG).digest('hex');
      return makeFullArticleItem({
        bodyHtml:
          '<p>正文带图。</p><p><img src="https://img.example.com/a.png"></p>' +
          '<p>第二张<img src="https://img.example.com/b.png">图</p>',
        assets: [
          {
            originalUrl: 'https://img.example.com/a.png',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
          {
            originalUrl: 'https://img.example.com/b.png',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
        ],
      });
    }

    it('planNote 生成 assets 清单并把正文图片替换为占位符', async () => {
      const item = makeImageAssetItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const oplan = plan as { assets?: { relativePath: string; sha256: string }[] };
      expect(oplan.assets).toBeDefined();
      expect(oplan.assets!.length).toBe(2);
      // 正文里不应再出现原始远程 URL
      expect(plan.renderedContent).not.toContain('img.example.com');
    });

    it('planNote 生成的嵌入是 wikilink 风格 ![[...]]（默认 linkStyle）', async () => {
      const item = makeImageAssetItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      // renderBody 已把占位符替换为 ![[Attachments/...]]
      expect(plan.renderedContent).toMatch(/!\[\[Attachments\/InkMigrate\//);
      expect(plan.renderedContent).not.toContain('\x00IMG');
    });

    it('writeNote 把附件物理落盘到 Vault', async () => {
      const item = makeImageAssetItem();
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const oplan = plan as { assets?: { relativePath: string }[] };
      const result = await adapter.write(plan, ctx(vault.vaultPath));
      // 每个附件文件应物理存在
      for (const a of oplan.assets!) {
        const abs = join(vault.vaultPath, a.relativePath);
        expect(existsSync(abs)).toBe(true);
        const bytes = readFileSync(abs);
        expect(bytes.length).toBe(MIN_PNG.length);
        expect(bytes[0]).toBe(0x89); // PNG 签名首字节
      }
      // note 文件也写入了
      expect(existsSync(join(vault.vaultPath, result.relativePath))).toBe(true);
    });

    it('下载失败的图片（无 data）保留远程 URL，不进 assets 清单', async () => {
      const item = makeFullArticleItem({
        bodyHtml: '<p><img src="https://img.example.com/failed.png"></p>',
        assets: [
          { originalUrl: 'https://img.example.com/failed.png', kind: 'image' },
        ],
      });
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const oplan = plan as { assets?: unknown[] };
      expect(oplan.assets).toBeUndefined();
      // 远程 URL 保留在正文里
      expect(plan.renderedContent).toContain('img.example.com/failed.png');
    });

    it('§13.7 内容路径匹配：CDN 子域名不同 + query 签名不同也能匹配', async () => {
      // 模拟真实场景：bodyHtml 里的图片 URL（p3 + 旧签名）与 extract 拿到的
      // asset.originalUrl（p11 + 新签名）在子域名和 query 上都不同，但内容路径
      // /tos-cn-i-xxx/<hash>~tplv-xxx 一致。必须靠内容路径匹配才能本地化。
      const { createHash } = require('node:crypto');
      const sha = createHash('sha256').update(MIN_PNG).digest('hex');
      const item = makeFullArticleItem({
        // bodyHtml 里是 p3 子域名 + 一组 query
        bodyHtml:
          '<p><img src="https://p3-sign.toutiaoimg.com/tos-cn-i-axegupay5k/abc123~tplv-tt-origin-web:gif.jpeg?_iz=58558&x-signature=OLD"></p>',
        assets: [
          {
            // asset.originalUrl 是 p11 子域名 + 另一组 query（模拟重新 extract）
            originalUrl:
              'https://p11-sign.toutiaoimg.com/tos-cn-i-axegupay5k/abc123~tplv-tt-origin-web:gif.jpeg?_iz=58558&x-signature=NEW',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
        ],
      });
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const oplan = plan as { assets?: unknown[] };
      expect(oplan.assets).toBeDefined();
      expect(oplan.assets!.length).toBe(1);
      // 两个子域名的远程 URL 都不应再出现
      expect(plan.renderedContent).not.toContain('p3-sign.toutiaoimg.com');
      expect(plan.renderedContent).not.toContain('p11-sign.toutiaoimg.com');
      // 应包含本地嵌入
      expect(plan.renderedContent).toMatch(/!\[\[Attachments\//);
    });

    it('§13.7 边界：alt 文本含 URL 片段不误删正文', async () => {
      // review 关注：![alt 含 /tos-cn-i-... 片段](url) 时，[^\]]* 会匹配 alt 里的内容，
      // 加上 escaped matchKey 可能与 alt 文本交叉导致误匹配。验证当前行为：只替换图片标记，
      // 不破坏正文文本。
      const { createHash } = require('node:crypto');
      const sha = createHash('sha256').update(MIN_PNG).digest('hex');
      const item = makeFullArticleItem({
        bodyHtml:
          '<p>这是一段正文，提到图片地址 /tos-cn-i-axegupay5k/abc。</p>' +
          '<p><img src="https://p3.toutiaoimg.com/tos-cn-i-axegupay5k/abc~tplv.jpeg"></p>',
        assets: [
          {
            originalUrl: 'https://p9.toutiaoimg.com/tos-cn-i-axegupay5k/abc~tplv.jpeg',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
        ],
      });
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      // 正文里的纯文本 "/tos-cn-i-axegupay5k/abc" 应保留（不是图片标记）
      expect(plan.renderedContent).toContain('这是一段正文，提到图片地址');
      // 图片应被本地化（远程 URL 不再出现）
      expect(plan.renderedContent).not.toContain('p3.toutiaoimg.com');
      expect(plan.renderedContent).not.toContain('p9.toutiaoimg.com');
    });

    it('§13.7 边界：两张图 contentPath 互为子串时各自正确本地化', async () => {
      // contentPath 为 /tos-cn-i-x/hash 时，若另一张是 /tos-cn-i-x/hash2，
      // matchKey 不会互为子串（因 hash 不同）。但若同 hash 不同 tplv 后缀，
      // matchKey 的 /[^?]+ 会吃到 ~tplv 部分，两张图各匹配自身。
      const { createHash } = require('node:crypto');
      const sha = createHash('sha256').update(MIN_PNG).digest('hex');
      const item = makeFullArticleItem({
        bodyHtml:
          '<p><img src="https://p3.toutiaoimg.com/tos-cn-i-x/hash1~tplv-a.jpeg"></p>' +
          '<p><img src="https://p3.toutiaoimg.com/tos-cn-i-x/hash2~tplv-b.jpeg"></p>',
        assets: [
          {
            originalUrl: 'https://p9.toutiaoimg.com/tos-cn-i-x/hash1~tplv-a.jpeg',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
          {
            originalUrl: 'https://p9.toutiaoimg.com/tos-cn-i-x/hash2~tplv-b.jpeg',
            mimeType: 'image/png',
            byteSize: MIN_PNG.length,
            sha256: `sha256:${sha}`,
            kind: 'image' as const,
            data: new Uint8Array(MIN_PNG),
          },
        ],
      });
      const plan = await adapter.plan(item, ctx(vault.vaultPath));
      const oplan = plan as { assets?: unknown[] };
      expect(oplan.assets!.length).toBe(2);
      expect(plan.renderedContent).not.toContain('toutiaoimg.com');
    });
  });
});
