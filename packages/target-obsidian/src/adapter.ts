import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import {
  computeStableKey,
  deriveItemKey,
  deriveStableShortId,
  sanitizeFilename,
  sourceContentHash,
  targetContentHash,
  writtenFileHash,
  assertSymlinkSafe,
  type SourceItem,
  type TargetAdapter,
  type TargetContext,
  type TargetWriteResult,
  type TargetPlan,
  type TargetVerification,
  type ValidationResult,
} from '@inkmigrate/core';
import { ObsidianTargetConfigSchema, type ObsidianTargetConfig } from './config.js';
import {
  validateVault,
  noteRelativePath,
  noteAbsolutePath,
  assetRelativePath,
  assetAbsolutePath,
} from './paths.js';
import { stringifyFrontmatter } from './frontmatter.js';
import { renderBody, htmlToMarkdown, convertEvernoteWikilinks } from './body.js';
import { atomicWrite, readTargetIfExists } from './atomic-write.js';
import { decideOverwrite } from './overwrite-policy.js';
import { writeAsset, verifyAsset, deriveMimeExtension } from './assets.js';
import {
  generateShardIndexes,
  type IndexEntry,
} from './indexes/index-generator.js';
import type { ObsidianWriteResult } from './result.js';

export const OBSIDIAN_TARGET_KIND = 'obsidian' as const;
export const OBSIDIAN_TARGET_VERSION = '1.0.0' as const;
export const OBSIDIAN_ADAPTER_API_VERSION = '1.0.0' as const;

/**
 * 头条 CDN 图片的内容路径（`/tos-cn-i-<biz>/<hash>~tplv-...`）：URL 中唯一稳定
 * 的部分（子域名与 query 签名每次变化），planNote 靠它在正文里定位图片引用。
 */
const TOUTIAO_CDN_CONTENT_PATH = /\/tos-cn-i-[^/]+\/[^?]+/;

export function createObsidianTarget(): ObsidianTargetAdapter {
  // adapter 实例级路径分配记录：stableKey → 已分配路径（Map）+ 已占用路径集合。
  // 以 stableKey 作键：同一 item 重试/重规划（同 Job 内重试、质量升级重写）复用
  // 已分配路径，保持幂等；usedPaths 集合防御同 Job 内两个不同指纹因 sanitize 后
  // title + shortId 恰好同形而撞路径的极端情况。
  const assignedPaths = new Map<string, string>();
  const usedPaths = new Set<string>();
  return {
    kind: OBSIDIAN_TARGET_KIND,
    version: OBSIDIAN_TARGET_VERSION,
    adapterApiVersion: OBSIDIAN_ADAPTER_API_VERSION,
    validateConfig,
    plan: (item, ctx) => planNote(item, ctx, assignedPaths, usedPaths),
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
 * §13.7 单个附件的写入计划。由 planNote 构造，writeNote 消费——
 * 在写 note 之前先把附件字节落盘（content-addressed，覆写语义）。
 */
export interface AssetWriteRecord {
  /** 附件在 Vault 内的相对路径（如 Attachments/InkMigrate/.../001.webp）。 */
  relativePath: string;
  /** 附件字节。 */
  data: Uint8Array;
  /** 附件 sha256（形如 sha256:<hex>），供 verifyAsset 校验。 */
  sha256: string;
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
  /** §13.7 要随 note 一起写入 Vault 的附件清单（已下载字节的图片）。 */
  assets?: AssetWriteRecord[];
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
  assignedPaths: Map<string, string>,
  usedPaths: Set<string>,
): Promise<ObsidianTargetPlan> {
  const config = parseConfig(ctx);
  validateVault(config.vaultPath);

  const stableKey = computeStableKey(
    item.ref.sourceInstanceId,
    item.ref.fingerprint,
  );
  const stableShortId = deriveStableShortId(stableKey);
  // §13.3 来源提供的笔记目录段（如 Evernote 的 Stack/笔记本层级）。
  // 仅接受字符串数组；缺失时（头条等）维持 contentKind 目录，行为不变。
  const rawSegments = (item.sourceMetadata as { notePathSegments?: unknown }).notePathSegments;
  const notePathSegments =
    Array.isArray(rawSegments) && rawSegments.every((s) => typeof s === 'string' && s.length > 0)
      ? (rawSegments as string[])
      : undefined;
  let relativePath = noteRelativePath({
    config,
    sourceInstanceId: item.ref.sourceInstanceId,
    contentKind: item.ref.contentKind,
    title: item.title,
    stableShortId,
    ...(notePathSegments !== undefined ? { notePathSegments } : {}),
  });

  // 文件名冲突解决：stableShortId 后缀已保证不同指纹落到不同稳定路径（§13.4），
  // 同一指纹重跑幂等地落到同一路径。故不再用 stat 检查磁盘文件——stat 预检
  // 既存在 TOCTOU 竞态（stat 与 atomicWrite 之间另一并发 Job 可能抢先写入），
  // 又会破坏幂等性（重跑时把已存在的幂等文件误判为冲突，生成 -2/-3 冗余副本）。
  //
  // assignedPaths 按 stableKey 记录（同 item 重规划复用原路径，避免重试产生 -2
  // 副本），usedPaths 集合防御同 Job 内两个不同指纹因 sanitize 后 title +
  // shortId 恰好同形的极端情况。真正的跨 Job 并发冲突由 DB 的
  // UNIQUE(target_instance_id, relative_path) 约束兜底——writeNote 落库时若撞
  // 约束会抛错，由上层标记为 conflict，不静默覆盖。
  const previouslyAssigned = assignedPaths.get(stableKey);
  if (previouslyAssigned !== undefined) {
    relativePath = previouslyAssigned;
  } else {
    let suffix = 2;
    while (usedPaths.has(relativePath)) {
      relativePath = `${relativePath.replace(/\.md$/, '')}-${suffix}.md`;
      suffix++;
    }
    usedPaths.add(relativePath);
    assignedPaths.set(stableKey, relativePath);
  }

  const srcHash = sourceContentHash(
    JSON.stringify(canonicalContentForHash(item)),
  );
  const frontmatter = stringifyFrontmatter({
    item,
    stableKey,
    sourceContentHash: srcHash,
  });

  // R9: bodyHtml 为纯空白时 htmlToMarkdown 返回 ''，原实现不回退 bodyText 导致正文丢失。
  // 改为：先尝试 bodyHtml→markdown，结果为空时回退 bodyText。
  let markdownBody = '';
  if (item.bodyHtml) {
    markdownBody = convertEvernoteWikilinks(htmlToMarkdown(item.bodyHtml), {
      sourceInstanceId: item.ref.sourceInstanceId,
      filenameShortId: config.filenameShortId,
      maxFilenameLength: config.maxFilenameLength,
    });
  }
  if (markdownBody.length === 0) {
    markdownBody = item.bodyText ?? '';
  }

  // §13.7 附件本地化：把已下载字节（asset.data）的图片替换为本地嵌入。
  // 只处理 kind==='image' 且携带 data 的 asset；下载失败的（无 data）保留远程 URL。
  // §15.7.4：asset.fileName 存在时优先用来源侧已清洗的原文件名（Evernote）；
  // 未设置时维持头条的序号命名。正文未匹配到、但携带 fileName 的资产（任意 kind，
  // 含未引用图片与 PDF/Office 等附件）写入附件目录并进文末附件区（§15.7.5）——
  // 头条资产不带 fileName，此门控保证其行为不变。
  const itemKey = deriveItemKey(stableKey);
  const assetLinks: { markdownPlaceholder: string; relativePath: string }[] = [];
  const attachmentLinks: string[] = [];
  const assetRecords: AssetWriteRecord[] = [];
  // §13.7 同笔记内附件路径去重：Evernote 导出常见两个附件同名（如都叫
  // image.png），assetRelativePath 会产出相同 relPath——后写覆盖前写字节、
  // 两处链接都指向同一（错误）文件。内容不同时追加 -2/-3 后缀消解；
  // 内容相同则复用同一路径（幂等覆写，双链接指向同一文件是正确语义）。
  const usedAssetPaths = new Map<string, string>(); // relPath → sha256
  const allocAssetPath = (
    args: {
      config: ObsidianTargetConfig;
      sourceInstanceId: string;
      itemKey: string;
      filename: string;
    },
    sha256: string,
  ): string => {
    let relPath = assetRelativePath(args);
    const known = usedAssetPaths.get(relPath);
    if (known === undefined) {
      usedAssetPaths.set(relPath, sha256);
      return relPath;
    }
    if (known === sha256) {
      return relPath; // 同名同内容：复用路径（幂等覆写）
    }
    let suffix = 2;
    const dot = args.filename.lastIndexOf('.');
    do {
      const uniq =
        dot > 0
          ? `${args.filename.slice(0, dot)}-${suffix}${args.filename.slice(dot)}`
          : `${args.filename}-${suffix}`;
      relPath = assetRelativePath({ ...args, filename: uniq });
      suffix++;
    } while (usedAssetPaths.has(relPath));
    usedAssetPaths.set(relPath, sha256);
    return relPath;
  };
  let imgIdx = 0;
  for (const asset of item.assets) {
    if (asset.data === undefined || asset.sha256 === undefined) {
      continue;
    }
    const hasFileName = asset.fileName !== undefined && asset.fileName.length > 0;
    if (asset.kind === 'image' && asset.originalUrl !== undefined) {
      // 在 markdownBody 里定位这张图片的引用，替换为唯一占位符。
      //
      // 匹配策略：头条 CDN 图片 URL 的子域名（p3/p9/p11 随机分配）和 query 参数
      // （x-signature/x-expires 每次新签名）会变化，但内容路径
      // `/tos-cn-i-xxx/<hash>~tplv-xxx` 是图片唯一标识，稳定不变。
      // 即便 extract 拿到的 URL 和 bodyHtml 里的子域名/签名不同也能匹配。
      // 内容路径不存在时（非头条图片）回退到完整 baseUrl（? 之前）精确匹配。
      const contentPath = asset.originalUrl.match(TOUTIAO_CDN_CONTENT_PATH)?.[0];
      const baseUrl = asset.originalUrl.split('?')[0] ?? asset.originalUrl;
      const matchKey = contentPath ?? baseUrl;
      const escaped = matchKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const placeholder = `\x00IMG${imgIdx}\x00`;
      const before = markdownBody;
      // matchKey 可能是完整 URL（含 https://）或仅内容路径（/tos-cn-i-...）。
      // 两种情况都用它在 url 位置匹配，前面允许任意协议+子域名，后面允许任意 query。
      // matchKey 必须锚定到 URL 末尾（其后仅允许 ?query/#fragment）：否则 matchKey
      // 只是另一 URL 的子串时（如 img.png 与 img@2x.png 前缀碰撞），先处理的资产
      // 会静默吞掉后者在正文中的引用，顺序相关且错位。
      markdownBody = markdownBody.replace(
        new RegExp(`!\\[[^\\]]*\\]\\([^)\\s]*${escaped}(?:[?#][^)\\s]*)?\\)`, 'g'),
        placeholder,
      );
      // 匹配 <img src="url..."> HTML 标签形式（turndown 未转换的残留），同样锚定。
      markdownBody = markdownBody.replace(
        new RegExp(`<img[^>]*src="[^"]*${escaped}(?:[?#][^"]*)?"[^>]*>`, 'g'),
        placeholder,
      );
      if (markdownBody !== before) {
        const ext = deriveMimeExtension(asset.mimeType ?? '');
        const filename = hasFileName
          ? sanitizeFilename(asset.fileName!, { maxLength: 200 })
          : `${String(imgIdx + 1).padStart(3, '0')}.${ext}`;
        const relPath = allocAssetPath(
          { config, sourceInstanceId: item.ref.sourceInstanceId, itemKey, filename },
          asset.sha256,
        );
        assetLinks.push({ markdownPlaceholder: placeholder, relativePath: relPath });
        assetRecords.push({ relativePath: relPath, data: asset.data, sha256: asset.sha256 });
        imgIdx++;
        continue;
      }
      // 正文里找不到该 url（可能是 css 背景图等未内联的资源）：无 fileName 的资产
      // 维持原行为（跳过）；有 fileName 的（Evernote 未引用资源）落入下方附件区。
    }
    if (hasFileName) {
      const ext = deriveMimeExtension(asset.mimeType ?? '');
      let filename = sanitizeFilename(asset.fileName!, { maxLength: 200 });
      if (!/\.[a-z0-9]{1,8}$/i.test(filename)) filename = `${filename}.${ext}`;
      // §13.7 flat 布局：同名异内容冲突消解（同名同内容天然幂等覆写）
      if (config.attachmentPathLayout === 'flat') {
        const abs = assetAbsolutePath(config.vaultPath, assetRelativePath({
          config, sourceInstanceId: item.ref.sourceInstanceId, itemKey, filename,
        }));
        if (existsSync(abs)) {
          const existing = createHash('sha256').update(readFileSync(abs)).digest('hex');
          const mine = asset.sha256!.replace(/^sha256:/, '');
          if (existing !== mine) {
            const stem = filename.replace(/\.[^.]+$/, '');
            filename = `${stem}-${mine.slice(0, 8)}${extname(filename)}`;
          }
        }
      }
      const relPath = allocAssetPath(
        { config, sourceInstanceId: item.ref.sourceInstanceId, itemKey, filename },
        asset.sha256,
      );
      attachmentLinks.push(relPath);
      assetRecords.push({ relativePath: relPath, data: asset.data, sha256: asset.sha256 });
    }
  }

  const body = renderBody({
    item,
    markdownBody,
    assetLinks,
    attachmentLinks,
    linkStyle: config.linkStyle,
  });

  const renderedContent = frontmatter + body;
  const targetHash = targetContentHash(renderedContent);

  const result: ObsidianTargetPlan = {
    relativePath,
    artifactKind: 'note',
    renderedContent,
    targetContentHash: targetHash,
    sourceContentHash: srcHash,
    isMetadataOnlyUpdate: false,
  };
  if (assetRecords.length > 0) {
    result.assets = assetRecords;
  }
  return result;
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

  if (decision.action === 'mark_conflict') {
    // §13.9 preserve/metadata-only + 用户修改 → 不写正文，保留用户文件。
    // 附件也一并不写：note 被跳过时附件会成为无人引用的孤儿文件，且
    // writeAsset 的覆写语义可能破坏磁盘上已存在的用户附件——先决策再落盘，
    // skippedWrite: true 才如实反映 Vault 状态。
    if (observedPrewriteFileHash === undefined) {
      // decideOverwrite 仅在 targetExists 时返回 mark_conflict，上方必已观测
      // 磁盘哈希；此守卫防止未来策略变化后把 undefined 落库破坏冲突审计。
      throw new Error(
        `mark_conflict returned but no prewrite hash was observed for "${oplan.relativePath}"`,
      );
    }
    // H-1: skippedWrite=true 让 job-runner 跳过 verify（否则 verify 读原文件 hash
    // 匹配会误判 ok=true，把冲突吞为 verified，永久跳过该条目）。
    return {
      relativePath: oplan.relativePath,
      artifactKind: 'note',
      targetContentHash: oplan.targetContentHash,
      writtenFileHash: observedPrewriteFileHash,
      sourceContentHash: oplan.sourceContentHash,
      wasForcedOverwrite: false,
      overwritePolicy: config.overwritePolicy,
      actionCode: 'stage_attempt',
      skippedWrite: true,
    };
  }

  // §13.7 先写附件（content-addressed，覆写语义），再写 note，
  // 保证 note 里的 ![[...]] 引用在 Obsidian 打开时附件已落盘。
  if (oplan.assets !== undefined && oplan.assets.length > 0) {
    for (const a of oplan.assets) {
      writeAsset({
        vaultPath: config.vaultPath,
        relativePath: a.relativePath,
        bytes: Buffer.from(a.data),
      });
      verifyAsset({
        vaultPath: config.vaultPath,
        relativePath: a.relativePath,
        expectedSha256: a.sha256,
      });
    }
  }

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
      // existsSync → atomicWrite 之间与 planNote 注释所述同样存在 TOCTOU 残留窗口
      // （另一并发 Job 可能抢先写入该候选路径）；本 Job 内为同步顺序执行无竞态，
      // 跨 Job 场景由 DB 唯一约束 + rename 原子性兜底，接受该窗口。
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
  // C6/一致性：读取前做 assertSymlinkSafe，与 verifyAsset 对齐。
  // 若笔记路径被替换为指向 Vault 外的 symlink，此处拒绝读取外部文件内容。
  // symlink 目标不存在或逃逸时归因为 ok:false，不向上抛错。
  try {
    assertSymlinkSafe(config.vaultPath, abs);
  } catch {
    return { ok: false, details: { reason: 'symlink escape' } };
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
