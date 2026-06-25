import {
  computeStableKey,
  deriveStableShortId,
  sourceContentHash,
  targetContentHash,
  writtenFileHash,
  type SourceItem,
  type TargetAdapter,
  type TargetContext,
  type TargetPlan,
  type TargetVerification,
  type ValidationResult,
} from '@inkmigrate/core';
import { ObsidianTargetConfigSchema, type ObsidianTargetConfig } from './config.js';
import { validateVault, noteRelativePath, noteAbsolutePath } from './paths.js';
import { stringifyFrontmatter } from './frontmatter.js';
import { renderBody, htmlToMarkdown } from './body.js';
import { atomicWrite, readTargetIfExists } from './atomic-write.js';
import { decideOverwrite } from './overwrite-policy.js';
import type { ObsidianWriteResult } from './result.js';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';

export const OBSIDIAN_TARGET_KIND = 'obsidian' as const;
export const OBSIDIAN_TARGET_VERSION = '1.0.0' as const;
export const OBSIDIAN_ADAPTER_API_VERSION = '1.0.0' as const;

export function createObsidianTarget(): ObsidianTargetAdapter {
  return {
    kind: OBSIDIAN_TARGET_KIND,
    version: OBSIDIAN_TARGET_VERSION,
    adapterApiVersion: OBSIDIAN_ADAPTER_API_VERSION,
    validateConfig,
    plan: planNote,
    write: writeNote,
    verify: verifyNote,
  };
}

export interface ObsidianTargetAdapter extends Omit<TargetAdapter, 'write'> {
  write(
    plan: TargetPlan,
    ctx: TargetContext,
    expectedWrittenFileHash?: string,
  ): Promise<ObsidianWriteResult>;
}

/**
 * §13.9/§17.5 plan 阶段预渲染好的完整文件内容。
 * write 阶段只接收 plan（§8.4 签名），所以 plan 必须携带渲染结果。
 */
export interface ObsidianTargetPlan extends TargetPlan {
  renderedContent: string;
  targetContentHash: string;
  sourceContentHash: string;
  isMetadataOnlyUpdate: boolean;
}

async function validateConfig(ctx: TargetContext): Promise<ValidationResult> {
  const parsed = ObsidianTargetConfigSchema.safeParse(ctx.targetConfig);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  try {
    validateVault(parsed.data.vaultPath);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  return { ok: true };
}

async function planNote(
  item: SourceItem,
  ctx: TargetContext,
): Promise<ObsidianTargetPlan> {
  const config = parseConfig(ctx);
  validateVault(config.vaultPath);

  const stableKey = computeStableKey(
    item.ref.sourceInstanceId,
    item.ref.fingerprint,
  );
  const stableShortId = deriveStableShortId(stableKey);
  let relativePath = noteRelativePath({
    config,
    sourceInstanceId: item.ref.sourceInstanceId,
    contentKind: item.ref.contentKind,
    title: item.title,
    stableShortId,
  });

  // 文件名冲突解决：使用异步 stat 检查文件是否存在（不阻塞事件循环）
  async function fileExists(p: string): Promise<boolean> {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  }

  if (await fileExists(noteAbsolutePath(config.vaultPath, relativePath))) {
    const baseName = relativePath.replace(/\.md$/, '');
    let suffix = 2;
    let candidate = relativePath;
    while (await fileExists(noteAbsolutePath(config.vaultPath, candidate))) {
      candidate = `${baseName}-${suffix}.md`;
      suffix++;
    }
    if (candidate !== relativePath) {
      relativePath = candidate;
    }
  }

  const srcHash = sourceContentHash(
    JSON.stringify(canonicalContentForHash(item)),
  );
  const frontmatter = stringifyFrontmatter({
    item,
    stableKey,
    migrationJobId:
      (ctx.targetConfig['__migrationJobId'] as string | undefined) ?? 'unknown',
    inkmigrateVersion: 1,
    sourceContentHash: srcHash,
    importedAt: new Date().toISOString(),
  });

  const markdownBody = item.bodyHtml
    ? htmlToMarkdown(item.bodyHtml)
    : (item.bodyText ?? '');
  const body = renderBody({
    item,
    markdownBody,
    assetLinks: [],
    linkStyle: config.linkStyle,
  });

  const renderedContent = frontmatter + body;
  const targetHash = targetContentHash(renderedContent);

  return {
    relativePath,
    artifactKind: 'note',
    renderedContent,
    targetContentHash: targetHash,
    sourceContentHash: srcHash,
    isMetadataOnlyUpdate: false,
  };
}

async function writeNote(
  plan: TargetPlan,
  ctx: TargetContext,
  expectedWrittenFileHash?: string,
): Promise<ObsidianWriteResult> {
  const config = parseConfig(ctx);
  validateVault(config.vaultPath);
  const oplan = plan as ObsidianTargetPlan;
  // §13.2 走 noteAbsolutePath（resolveWithin）确保路径不逃逸 Vault。
  const absPath = noteAbsolutePath(config.vaultPath, oplan.relativePath);

  const existing = readTargetIfExists(absPath);
  const targetExists = existing !== undefined;
  let observedPrewriteFileHash: string | undefined;
  let userModified = false;
  if (targetExists && expectedWrittenFileHash !== undefined) {
    observedPrewriteFileHash = writtenFileHash(Buffer.from(existing!, 'utf8'));
    userModified = observedPrewriteFileHash !== expectedWrittenFileHash;
  }

  const decideInput: Parameters<typeof decideOverwrite>[0] = {
    config,
    targetExists,
    userModified,
    isMetadataOnlyUpdate: oplan.isMetadataOnlyUpdate,
  };
  if (observedPrewriteFileHash !== undefined) {
    decideInput.observedPrewriteFileHash = observedPrewriteFileHash;
  }
  if (expectedWrittenFileHash !== undefined) {
    decideInput.expectedWrittenFileHash = expectedWrittenFileHash;
  }
  const decision = decideOverwrite(decideInput);

  let finalRelativePath = oplan.relativePath;
  const contentToWrite = oplan.renderedContent;

  switch (decision.action) {
    case 'write_canonical':
    case 'forced_overwrite':
    case 'update_metadata_only':
      atomicWrite(absPath, contentToWrite, config.vaultPath);
      break;
    case 'write_new_variant': {
      finalRelativePath = oplan.relativePath.replace(/\.md$/, '.imported-new.md');
      atomicWrite(
        noteAbsolutePath(config.vaultPath, finalRelativePath),
        contentToWrite,
        config.vaultPath,
      );
      break;
    }
    case 'mark_conflict':
      // §13.9 preserve + 用户修改 → 不写正文，保留用户文件
      return {
        relativePath: oplan.relativePath,
        artifactKind: 'note',
        targetContentHash: oplan.targetContentHash,
        writtenFileHash: observedPrewriteFileHash!,
        sourceContentHash: oplan.sourceContentHash,
        wasForcedOverwrite: false,
        overwritePolicy: config.overwritePolicy,
        actionCode: 'stage_attempt',
      };
  }

  const finalAbs = noteAbsolutePath(config.vaultPath, finalRelativePath);
  const finalHash = writtenFileHash(readFileSync(finalAbs));

  const result: ObsidianWriteResult = {
    relativePath: finalRelativePath,
    artifactKind: decision.artifactKind,
    targetContentHash: oplan.targetContentHash,
    writtenFileHash: finalHash,
    sourceContentHash: oplan.sourceContentHash,
    wasForcedOverwrite: decision.action === 'forced_overwrite',
    overwritePolicy: config.overwritePolicy,
    actionCode:
      decision.action === 'forced_overwrite'
        ? 'forced_overwrite'
        : decision.action === 'write_new_variant'
          ? 'write_new_variant'
          : 'stage_attempt',
  };
  if (decision.observedPrewriteFileHash !== undefined) {
    result.observedPrewriteFileHash = decision.observedPrewriteFileHash;
  }
  if (decision.expectedWrittenFileHash !== undefined) {
    result.expectedWrittenFileHash = decision.expectedWrittenFileHash;
  }
  return result;
}

async function verifyNote(
  result: { relativePath: string; writtenFileHash: string },
  ctx: TargetContext,
): Promise<TargetVerification> {
  const config = parseConfig(ctx);
  const abs = noteAbsolutePath(config.vaultPath, result.relativePath);
  if (!existsSync(abs)) {
    return { ok: false, details: { reason: 'file missing' } };
  }
  const bytes = readFileSync(abs);
  if (bytes.length === 0) {
    return { ok: false, details: { reason: 'empty file' } };
  }
  const actual = writtenFileHash(bytes);
  if (actual !== result.writtenFileHash) {
    return {
      ok: false,
      details: {
        reason: 'hash mismatch (user-modified)',
        expected: result.writtenFileHash,
        actual,
      },
    };
  }
  return { ok: true };
}

function parseConfig(ctx: TargetContext): ObsidianTargetConfig {
  return ObsidianTargetConfigSchema.parse(ctx.targetConfig);
}

/** §13.9 sourceContentHash 输入：标准化的来源正文 + 链接 + 资源清单。 */
function canonicalContentForHash(item: SourceItem): unknown {
  return {
    bodyHtml: item.bodyHtml ?? '',
    bodyText: item.bodyText ?? '',
    links: item.links.map((l) => ({ url: l.url, text: l.text, kind: l.kind })),
    assets: item.assets.map((a) => ({
      externalId: a.externalId,
      originalUrl: a.originalUrl,
      mimeType: a.mimeType,
    })),
    tags: item.tags,
    collections: item.collections,
  };
}
