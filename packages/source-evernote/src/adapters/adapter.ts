import {
  computeFingerprint,
  downloadImage,
  type SourceAdapter,
  type SourceItem,
  type SourceItemRef,
  type SourceLink,
  type ValidationResult,
} from '@inkmigrate/core';
import {
  EVERNOTE_CAPABILITIES,
  SOURCE_EVERNOTE_ADAPTER_API_VERSION,
  SOURCE_EVERNOTE_KIND,
  SOURCE_EVERNOTE_VERSION,
} from '../capabilities.js';
import {
  EvernoteSourceConfigSchema,
  type EvernoteSourceConfig,
  type EvernoteSourceConfigInput,
} from '../config.js';
import {
  collectEnexFiles,
  resolveInputPaths,
  type EnexFileInfo,
} from '../enex/scan.js';
import { enexTimeToIso, streamNotes, type RawNote } from '../enex/sax-notes.js';
import { buildNoteIdentity } from '../enex/identity.js';
import { processResources, type ProcessedResource } from '../resources/process-resources.js';
import { enmlToHtml } from '../enml/enml-to-html.js';
import { extractHtmlNote, scanHtmlNote } from '../html/html-export.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { dirname } from 'node:path';

/**
 * §15 Evernote 来源适配器.
 *
 * - scan：收集 ENEX/HTML 导出 → 轻量索引（标题/时间/定位信息）→ SourceItemRef。
 *   ref.sourceMetadata.enex / .html 携带重新定位所需的一切。
 * - extract：按 metadata 分派（ENEX 重读文件到目标序号 / HTML 解析单文件）→
 *   资源管线 → 正文转换 → SourceItem。
 *   文件哈希与扫描时不一致视为文件已变化，抛错由引擎重试/失败（§15.3 完整性）。
 * - .notes 输入在 scan 阶段显式失败（EvernoteNotesRejectedError，§15.2.1）。
 */

export interface EnexRefMetadata {
  path: string;
  baseName: string;
  ordinal: number;
  fileSha256: string;
  notebook: string;
  stack?: string | undefined;
  notebookKey: string;
}

export interface HtmlRefMetadata {
  path: string;
  relPath: string;
  fileSha256: string;
  notebook: string;
  resourcesDir?: string | undefined;
  exportRoot: string;
}

interface ScanState {
  /** 非致命扫描问题（损坏文件等），供诊断输出。 */
  issues: string[];
  skippedInputs: string[];
}

/** HTML 文件的导出根：包含它的那个输入路径（文件输入取其父目录）。 */
function exportRootFor(htmlPath: string, inputRoots: readonly string[]): string {
  let best = dirname(htmlPath);
  for (const root of inputRoots) {
    if (htmlPath === root || htmlPath.startsWith(`${root}/`)) {
      if (root.length >= best.length) best = root;
    }
  }
  return best;
}

function refMetaOf(ref: SourceItemRef): { enex?: EnexRefMetadata; html?: HtmlRefMetadata } {
  const meta = ref.sourceMetadata as { enex?: EnexRefMetadata; html?: HtmlRefMetadata };
  if (meta.enex === undefined && meta.html === undefined) {
    throw new Error(
      `ref ${ref.externalId} is missing sourceMetadata.enex/.html (not produced by this adapter)`,
    );
  }
  return meta;
}

async function sha256FileQuick(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

type EvernoteAdapter = SourceAdapter & { __scanState?: ScanState };

/**
 * §15 Evernote 来源适配器工厂。
 *
 * 配置随工厂参数捕获（与 createToutiaoSource 同模式）：job-runner 调用
 * scan/extract 时传的是空 config，运行时配置必须由适配器自持。
 * 构造时即用 zod 校验并填充默认值，非法配置在工厂调用处抛错。
 */
export function createEvernoteSource(input: EvernoteSourceConfigInput): EvernoteAdapter {
  const cfg: EvernoteSourceConfig = EvernoteSourceConfigSchema.parse(input);
  const scanState: ScanState = { issues: [], skippedInputs: [] };

  const adapter: EvernoteAdapter = {
    kind: SOURCE_EVERNOTE_KIND,
    version: SOURCE_EVERNOTE_VERSION,
    adapterApiVersion: SOURCE_EVERNOTE_ADAPTER_API_VERSION,
    capabilities: EVERNOTE_CAPABILITIES,

    async validateConfig(): Promise<ValidationResult> {
      // 配置已在工厂调用时校验；此处仅对契约保持形状（无 ctx.config 可验证）
      return { ok: true };
    },

    async prepare(ctx): Promise<void> {
      // 预检：路径可达 + .notes 显式失败（§15.2.1）提前到 prepare，避免迁移半途报错
      await collectEnexFiles(resolveInputPaths(cfg.inputPaths, ctx.workspaceDir), cfg.stackSeparator, {
        includeHtml: cfg.formats.includes('html'),
      });
    },

    async *scan(ctx): AsyncGenerator<SourceItemRef> {
      scanState.issues = [];
      scanState.skippedInputs = [];
      const inputRoots = resolveInputPaths(cfg.inputPaths, ctx.workspaceDir);
      const includeHtml = cfg.formats.includes('html');
      const { files, htmlFiles, skipped } = await collectEnexFiles(
        inputRoots,
        cfg.stackSeparator,
        { includeHtml },
      );
      scanState.skippedInputs = skipped;

      for (const file of files) {
        const notes: Array<{ ordinal: number; title: string; createdIso: string | undefined }> = [];
        const outcome = await streamNotes(file.path, {
          headerOnly: true,
          onNote: (n) => notes.push({ ordinal: n.ordinal, title: n.title, createdIso: enexTimeToIso(n.created) }),
          onIssue: (msg) => scanState.issues.push(`${file.baseName}.enex: ${msg}`),
        });
        if (outcome.error !== undefined) {
          // §15.3 损坏隔离：已读出的笔记照常产出；错误记录供诊断，文件级继续
          scanState.issues.push(`${file.path}: ${outcome.error.message}（已读出 ${notes.length} 条）`);
        }
        for (const n of notes) {
          const { externalId, fingerprint } = buildNoteIdentity({
            fileSha256: file.sha256,
            ordinal: n.ordinal,
            title: n.title,
            createdIso: n.createdIso,
            fileBaseName: file.baseName,
          });
          const meta: EnexRefMetadata = {
            path: file.path,
            baseName: file.baseName,
            ordinal: n.ordinal,
            fileSha256: file.sha256,
            notebook: file.notebook,
            stack: file.stack,
            notebookKey: file.notebookKey,
          };
          yield {
            sourceInstanceId: cfg.sourceInstanceId,
            externalId,
            title: n.title.length > 0 ? n.title : `未命名笔记 #${n.ordinal}`,
            contentKind: 'note',
            discoveredAt: new Date().toISOString(),
            sourcePosition: n.ordinal,
            fingerprint,
            sourceMetadata: { enex: meta },
          };
        }
      }

      // §15.12 HTML 导出：每条 .html 一个笔记
      if (includeHtml) {
        for (const htmlPath of htmlFiles) {
          const exportRoot = exportRootFor(htmlPath, inputRoots);
          const header = scanHtmlNote(htmlPath, exportRoot);
          const fingerprint = computeFingerprint({
            raw: [header.fileSha256, header.title].join('\0'),
          });
          yield {
            sourceInstanceId: cfg.sourceInstanceId,
            externalId: `html:${header.relPath}`,
            title: header.title,
            contentKind: 'note',
            discoveredAt: new Date().toISOString(),
            fingerprint,
            sourceMetadata: {
              html: {
                path: header.path,
                relPath: header.relPath,
                fileSha256: header.fileSha256,
                notebook: header.notebook,
                ...(header.resourcesDir !== undefined ? { resourcesDir: header.resourcesDir } : {}),
                exportRoot,
              },
            },
          };
        }
      }
    },

    async extract(ref): Promise<SourceItem> {
      const meta = refMetaOf(ref);

      // §15.3 完整性：扫描与提取之间文件被修改即失败（指纹输入含文件哈希，静默继续会错账）
      const filePath = meta.enex?.path ?? meta.html?.path;
      const expectedSha = meta.enex?.fileSha256 ?? meta.html?.fileSha256;
      const currentSha = await sha256FileQuick(filePath!);
      if (currentSha !== expectedSha) {
        throw new Error(
          `导出文件在扫描后被修改：${filePath}（期望 ${expectedSha!.slice(0, 8)}，实际 ${currentSha.slice(0, 8)}），请重新扫描`,
        );
      }

      // §15.12 HTML 导出分派
      if (meta.html !== undefined) {
        return extractHtmlAsItem(ref, meta.html, cfg);
      }
      const enexMeta = meta.enex!;

      let raw: RawNote | undefined;
      const outcome = await streamNotes(enexMeta.path, {
        stopAfterOrdinal: enexMeta.ordinal,
        onNote: (n) => {
          if (n.ordinal === enexMeta.ordinal) raw = n;
        },
      });
      if (raw === undefined) {
        throw new Error(
          `笔记 #${enexMeta.ordinal} 不存在于 ${enexMeta.path}${outcome.error !== undefined ? `（解析错误：${outcome.error.message}）` : ''}`,
        );
      }

      const note = raw;
      const createdIso = enexTimeToIso(note.created);
      const updatedIso = enexTimeToIso(note.updated);

      // §15.7 资源管线
      const processed = processResources(note.resources, {
        maxResourceBytes: cfg.assets.maxResourceBytes,
      });
      const resourceByMd5 = new Map(
        processed.resources.map((r) => [
          r.md5Hex,
          { kind: r.asset.kind, fileName: r.fileName, attachment: r.attachment },
        ]),
      );

      // §15.6 ENML 转换
      const transform = enmlToHtml(note.content ?? '', resourceByMd5);

      // §15.6 远程图片下载（与 §12.10 同一管线；默认关闭不发起网络请求）
      const assets = processed.resources.map((r) => r.asset);
      const degradations: SourceItem['degradations'] = [];
      const warnings: string[] = [];
      if (cfg.assets.downloadImages && transform.remoteImages.length > 0) {
        let okCount = 0;
        let failCount = 0;
        for (const remote of transform.remoteImages) {
          const r = await downloadImage({
            url: remote.url,
            maxBytes: cfg.assets.maxImageBytes,
            maxRetries: 1,
          });
          if (r.ok) {
            okCount += 1;
            assets.push({
              originalUrl: remote.url,
              mimeType: r.mimeType,
              byteSize: r.byteSize,
              sha256: `sha256:${createHash('sha256').update(r.bytes).digest('hex')}`,
              kind: 'image',
              data: r.bytes,
            });
          } else {
            failCount += 1;
          }
        }
        if (failCount > 0) {
          degradations.push({
            code: 'asset-incomplete',
            stage: 'assets',
            message: `${failCount} 张远程图片下载失败，已保留远程链接`,
          });
        }
        warnings.push(`远程图片：引用 ${transform.remoteImages.length}，落地 ${okCount}，失败 ${failCount}`);
      } else if (transform.remoteImages.length > 0) {
        warnings.push(
          `远程图片：引用 ${transform.remoteImages.length}，未下载（assets.downloadImages=false，保留远程链接）`,
        );
      }

      // §15.13 对账计数（进入 extractionWarnings，报告层可聚合）
      if (processed.failures.length > 0) {
        degradations.push({
          code: 'asset-incomplete',
          stage: 'assets',
          message: `${processed.failures.length} 个资源解码/校验失败：${processed.failures
            .map((f) => `#${f.index + 1} ${f.reason}`)
            .join('；')}`,
        });
      }
      if (transform.missingMediaHashes.length > 0) {
        degradations.push({
          code: 'asset-incomplete',
          stage: 'assets',
          message: `${transform.missingMediaHashes.length} 处 en-media 找不到匹配资源（哈希不一致）`,
        });
      }
      if (transform.cryptBlocks.length > 0) {
        degradations.push({
          code: 'unsupported-structure',
          stage: 'normalize',
          message: `${transform.cryptBlocks.length} 个加密块以占位符保留（不破解，§15.11）`,
        });
      }
      if (transform.internalLinks.length > 0) {
        warnings.push(
          `内部链接：${transform.internalLinks.length} 条未解析（ENEX 无 GUID 映射，保留原始链接，§15.10）`,
        );
      }
      const unreferenced = processed.resources.filter(
        (r) => !transform.html.includes(`enex-resource://${r.md5Hex}`),
      ).length;
      warnings.push(
        [
          `资源对账：总数 ${note.resources.length}`,
          `成功 ${processed.resources.length}`,
          `失败 ${processed.failures.length}`,
          `缺失引用 ${transform.missingMediaHashes.length}`,
          `未引用 ${unreferenced}`,
          `重复内容 ${processed.duplicates}`,
          `MIME 不一致 ${processed.mimeMismatches}`,
        ].join('，'),
      );

      // §15.8 元数据
      const attrs = note.noteAttributes;
      const sourceUrl = attrs['source-url'];
      const links: SourceLink[] = [
        ...transform.externalLinks.map((l) => ({ ...l, kind: 'external' as const })),
        ...transform.internalLinks.map((l) => ({ ...l, kind: 'internal' as const })),
      ];

      const sourceMetadata: Record<string, unknown> = {
        enex: enexMeta,
        notebook: enexMeta.notebook,
        stack: enexMeta.stack,
        source_type: attrs.source,
        source_url: sourceUrl,
        reminder_order: attrs['reminder-order'],
        content_class: attrs['content-class'],
        enml_todo_count: transform.todoCount,
      };

      return {
        ref,
        title: ref.title ?? (note.title.length > 0 ? note.title : '未命名笔记'),
        ...(attrs.author !== undefined ? { author: attrs.author } : {}),
        ...(createdIso !== undefined ? { createdAt: createdIso } : {}),
        ...(updatedIso !== undefined
          ? { updatedAt: updatedIso }
          : createdIso !== undefined
            ? { updatedAt: createdIso }
            : {}),
        bodyHtml: transform.html,
        ...(transform.html.length > 0
          ? { bodyText: transform.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
          : {}),
        tags: note.tags,
        collections: [enexMeta.notebook],
        assets,
        links,
        quality: degradations.length > 0 ? 'degraded' : 'full',
        degradations,
        extractionMethod: 'evernote-enex-sax-v1',
        extractionWarnings: warnings,
        sourceMetadata,
      };
    },

    async close(): Promise<void> {
      // 文件源无长生命周期资源
    },
  };
  adapter.__scanState = scanState;
  return adapter;
}

/** 测试/诊断辅助：最近一次 scan 的非致命问题（损坏文件等）。 */
export function lastScanIssues(adapter: SourceAdapter): readonly string[] {
  return ((adapter as EvernoteAdapter).__scanState ?? { issues: [] }).issues;
}

/** §15.12 HTML 导出笔记 → SourceItem（文件级完整性已在 extract 入口校验）。 */
async function extractHtmlAsItem(
  ref: SourceItemRef,
  meta: HtmlRefMetadata,
  cfg: EvernoteSourceConfig,
): Promise<SourceItem> {
  const result = extractHtmlNote(meta.path, meta.exportRoot);
  const degradations: SourceItem['degradations'] = [];
  const warnings: string[] = [];
  const assets = [...result.assets];

  // §15.6 远程图片下载（与 ENEX 路径同一管线；默认关闭不发起网络请求）
  if (cfg.assets.downloadImages && result.remoteImages.length > 0) {
    let okCount = 0;
    let failCount = 0;
    for (const remote of result.remoteImages) {
      const r = await downloadImage({
        url: remote.url,
        maxBytes: cfg.assets.maxImageBytes,
        maxRetries: 1,
      });
      if (r.ok) {
        okCount += 1;
        assets.push({
          originalUrl: remote.url,
          mimeType: r.mimeType,
          byteSize: r.byteSize,
          sha256: `sha256:${createHash('sha256').update(r.bytes).digest('hex')}`,
          kind: 'image',
          data: r.bytes,
        });
      } else {
        failCount += 1;
      }
    }
    if (failCount > 0) {
      degradations.push({
        code: 'asset-incomplete',
        stage: 'assets',
        message: `${failCount} 张远程图片下载失败，已保留远程链接`,
      });
    }
    warnings.push(`远程图片：引用 ${result.remoteImages.length}，落地 ${okCount}，失败 ${failCount}`);
  } else if (result.remoteImages.length > 0) {
    warnings.push(
      `远程图片：引用 ${result.remoteImages.length}，未下载（assets.downloadImages=false，保留远程链接）`,
    );
  }

  // §15.13 对账计数
  if (result.missingResources > 0) {
    degradations.push({
      code: 'asset-incomplete',
      stage: 'assets',
      message: `${result.missingResources} 处本地资源引用未解析（文件缺失或逃逸导出目录）`,
    });
  }
  warnings.push(
    `资源对账：本地成功 ${result.resolvedResources}，缺失 ${result.missingResources}，外链 ${result.externalLinksCount}，远程图片 ${result.remoteImages.length}`,
  );
  if (result.links.some((l) => l.kind === 'internal')) {
    warnings.push('内部链接：保留原始链接（§15.10）');
  }

  return {
    ref,
    title: ref.title ?? '未命名笔记',
    bodyHtml: result.bodyHtml,
    ...(result.bodyHtml.length > 0
      ? { bodyText: result.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
      : {}),
    tags: [],
    collections: [meta.notebook],
    assets,
    links: result.links,
    quality: degradations.length > 0 ? 'degraded' : 'full',
    degradations,
    extractionMethod: 'evernote-html-export-v1',
    extractionWarnings: warnings,
    sourceMetadata: {
      html: meta,
      notebook: meta.notebook,
    },
  };
}

export type { EnexFileInfo, ProcessedResource };
