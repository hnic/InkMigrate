import {
  computeStableKey,
  deriveStableShortId,
  sourceContentHash,
  targetContentHash,
  writtenFileHash,
  type SourceItem,
  type TargetAdapter,
  type TargetContext,
  type TargetWriteResult,
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
import {
  generateShardIndexes,
  type IndexEntry,
} from './indexes/index-generator.js';
import type { ObsidianWriteResult } from './result.js';
import { existsSync, readFileSync } from 'node:fs';

export const OBSIDIAN_TARGET_KIND = 'obsidian' as const;
export const OBSIDIAN_TARGET_VERSION = '1.0.0' as const;
export const OBSIDIAN_ADAPTER_API_VERSION = '1.0.0' as const;

export function createObsidianTarget(): ObsidianTargetAdapter {
  // adapter 实例级路径去重 Set，防止同一 Job 内标题重复的条目分配到相同路径
  const assignedPaths = new Set<string>();
  return {
    kind: OBSIDIAN_TARGET_KIND,
    version: OBSIDIAN_TARGET_VERSION,
    adapterApiVersion: OBSIDIAN_ADAPTER_API_VERSION,
    validateConfig,
    plan: (item, ctx) => planNote(item, ctx, assignedPaths),
    write: writeNote,
    writeWithExpectedHash: (plan, ctx, expectedWrittenFileHash) =>
      writeNote(plan, ctx, expectedWrittenFileHash),
    verify: verifyNote,
    renderIndex: (ctx) => renderIndexNotes(ctx),
  };
}

export interface ObsidianTargetAdapter extends Omit<TargetAdapter, 'write'> {
  write(
    plan: TargetPlan,
    ctx: TargetContext,
    expectedWrittenFileHash?: string,
  ): Promise<ObsidianWriteResult>;
  writeWithExpectedHash?(
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
  assignedPaths: Set<string>,
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

  // 文件名冲突解决：stableShortId 后缀已保证不同指纹落到不同稳定路径（§13.4），
  // 同一指纹重跑幂等地落到同一路径。故不再用 stat 检查磁盘文件——stat 预检
  // 既存在 TOCTOU 竞态（stat 与 atomicWrite 之间另一并发 Job 可能抢先写入），
  // 又会破坏幂等性（重跑时把已存在的幂等文件误判为冲突，生成 -2/-3 冗余副本）。
  //
  // 仅保留 assignedPaths（同 Job 内去重 Set，同步操作无竞态）作为防御：
  // 处理同 Job 内两个不同指纹因 sanitize 后 title + shortId 恰好同形的极端情况。
  // 真正的跨 Job 并发冲突由 DB 的 UNIQUE(target_instance_id, relative_path) 约束
  // 兜底——writeNote 落库时若撞约束会抛错，由上层标记为 conflict，不静默覆盖。
  let suffix = 2;
  while (assignedPaths.has(relativePath)) {
    relativePath = `${relativePath.replace(/\.md$/, '')}-${suffix}.md`;
    suffix++;
  }
  assignedPaths.add(relativePath);

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
  } else if (targetExists && expectedWrittenFileHash === undefined) {
    // §缺陷1（数据丢失防护）：目标已存在但 DB 无 writtenFileHash 记录（首次迁移
    // 遇到用户手写同名笔记 / DB 损坏后重跑）。无法判定文件归属 → 保守视为"用户/
    // 外来所有"，userModified=true 使 preserve/metadata-only 走 mark_conflict
    // 挂起保护，绝不默认 write_canonical 静默覆写用户数据。
    observedPrewriteFileHash = writtenFileHash(Buffer.from(existing!, 'utf8'));
    userModified = true;
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
  let finalHash: string;

  switch (decision.action) {
    case 'write_canonical':
    case 'forced_overwrite':
    case 'update_metadata_only':
      finalHash = atomicWrite(absPath, contentToWrite, config.vaultPath);
      break;
    case 'write_new_variant': {
      // M10: 变体路径未做存在性检查——连续两次 write-new 跑同一 item 会覆盖前次变体
      // （真实数据丢失）。改为：若 .imported-new.md 已存在，递增后缀（-2, -3...）。
      const variantBase = oplan.relativePath.replace(/\.md$/, '.imported-new');
      let candidate = `${variantBase}.md`;
      let suffix = 2;
      while (existsSync(noteAbsolutePath(config.vaultPath, candidate))) {
        candidate = `${variantBase}-${suffix}.md`;
        suffix++;
      }
      finalRelativePath = candidate;
      finalHash = atomicWrite(
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

/**
 * §13.8 索引生成（renderIndex）：把本 Job 已写入的笔记条目生成为分片索引 +
 * 总入口索引，返回 TargetWriteResult[] 供 Job Runner 落库为 artifact_kind='index'。
 *
 * 入口由 ctx.indexEntries / ctx.sourceInstanceId 提供（Job Runner 在 generating_indexes
 * 阶段填充）；无条目 → 空数组（不报错，适配器不强制支持索引）。
 *
 * §13.8 重跑保护：ctx.knownIndexArtifacts 传入上一轮落库的索引哈希，用户手改过的
 * 分片不会被覆写（generateShardIndexes 内部处理）。
 */
async function renderIndexNotes(ctx: TargetContext): Promise<TargetWriteResult[]> {
  const config = parseConfig(ctx);
  validateVault(config.vaultPath);
  const sourceInstanceId = ctx.sourceInstanceId;
  const inputs = ctx.indexEntries;
  if (sourceInstanceId === undefined || inputs === undefined || inputs.length === 0) {
    return [];
  }
  const entries: IndexEntry[] = inputs.map((e) => ({
    title: e.title,
    relativePath: e.relativePath,
    contentKind: e.contentKind,
    ...(e.publishedAt !== undefined ? { publishedAt: e.publishedAt } : {}),
    ...(e.favoritedAt !== undefined ? { favoritedAt: e.favoritedAt } : {}),
    collections: [...e.collections],
  }));
  const result = generateShardIndexes({
    config,
    vaultPath: config.vaultPath,
    sourceInstanceId,
    entries,
    groupBy: config.indexGroupBy,
    ...(ctx.knownIndexArtifacts !== undefined
      ? { knownArtifacts: ctx.knownIndexArtifacts }
      : {}),
  });
  // 桥接 GenerateIndexResult → TargetWriteResult[]（relativePath + 写入哈希）
  const out: TargetWriteResult[] = [];
  for (const shard of result.shards) {
    if (shard.writtenFileHash === undefined) continue;
    out.push({
      relativePath: shard.relativePath,
      targetContentHash: shard.writtenFileHash, // 索引内容哈希 = 写入字节哈希
      writtenFileHash: shard.writtenFileHash,
    });
  }
  if (result.entryIndex.writtenFileHash !== undefined) {
    out.push({
      relativePath: result.entryIndex.relativePath,
      targetContentHash: result.entryIndex.writtenFileHash,
      writtenFileHash: result.entryIndex.writtenFileHash,
    });
  }
  return out;
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
