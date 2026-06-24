import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createObsidianTarget } from '../src/adapter.js';
import { makeTempVault } from './helpers/vault.js';
import { makeFullArticleItem, makeDegradedItem } from './helpers/fixtures.js';
import {
  computeStableKey,
  deriveStableShortId,
  type TargetContext,
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
      expect(plan.relativePath).toContain(deriveStableShortId(stableKey));
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
      expect(content).toContain('# 人工智能如何改变软件开发');
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
      expect(content).toContain('# 人工智能如何改变软件开发');
      expect(content).toContain('来源信息');
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
});
