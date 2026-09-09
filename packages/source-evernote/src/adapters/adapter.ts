import {
  computeFingerprint,
  downloadImage,
  type SourceAdapter,
  type SourceAsset,
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
import { createReadStream, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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
  /** §15.3 大文件快速完整性校验（size+mtime 未变则跳过全文件 SHA）。 */
  sizeBytes: number;
  mtimeMs: number;
  notebook: string;
  stack?: string | undefined;
  notebookKey: string;
  /** §13.3 笔记目录段：[Stack?, `<笔记本>-<notebookKey前8位>`]。 */
  notePathSegments: string[];
  /** evernote-backup --add-guid 扩展携带的稳定 GUID（§15.4 第 1 优先级身份）。 */
  guid?: string | undefined;
}

export interface HtmlRefMetadata {
  path: string;
  relPath: string;
  fileSha256: string;
  notebook: string;
  resourcesDir?: string | undefined;
  exportRoot: string;
  /** §13.3 笔记目录段（notebookKey = SHA-256(相对目录 + NUL + 笔记本名)）。 */
  notePathSegments: string[];
}

/** §13.3/§15.5：笔记本目录段 = [Stack?, `<笔记本名>[-<notebookKey前8位>]`]。 */
export function buildNotePathSegments(
  notebook: string,
  notebookKey: string,
  stack: string | undefined,
  shortId = true,
): string[] {
  const notebookDir = shortId ? `${notebook}-${notebookKey.slice(0, 8)}` : notebook;
  return stack !== undefined && stack.length > 0 ? [stack, notebookDir] : [notebookDir];
}

interface ScanState {
  /** 非致命扫描问题（损坏文件等），供诊断输出。 */
  issues: string[];
  skippedInputs: string[];
}

/** HTML 文件的导出根：包含它的那个输入路径（文件输入取其父目录）。 */
function exportRootFor(htmlPath: string, inputRoots: readonly string[]): string {
  const absHtml = resolve(htmlPath);
  let best = dirname(absHtml);
  for (const root of inputRoots) {
    // 两侧统一绝对化后按 path.relative 判定包含，避免 ./ 前缀、尾斜杠、
    // 分隔符差异等形态不一致导致误判回退到父目录
    const absRoot = resolve(root);
    const rel = relative(absRoot, absHtml);
    const contains = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (contains && absRoot.length >= best.length) best = absRoot;
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

/**
 * §15.10 GUID 映射项：scan 与跨进程懒重建（ensureGuidMap）共用同一条目构造，
 * 保证两侧指纹输入（含 createdIso）与覆盖语义（重复 GUID 后者覆盖）完全一致，
 * 避免 resume 后内部链接解析到不同目标。
 */
function guidMapEntryOf(
  file: EnexFileInfo,
  n: Pick<RawNote, 'guid' | 'ordinal' | 'title' | 'created'>,
): { title: string; fingerprint: string } {
  const { fingerprint } = buildNoteIdentity({
    guid: n.guid,
    fileSha256: file.sha256,
    ordinal: n.ordinal,
    title: n.title,
    createdIso: enexTimeToIso(n.created),
    fileBaseName: file.baseName,
  });
  return {
    title: n.title.length > 0 ? n.title : `未命名笔记 #${n.ordinal}`,
    fingerprint,
  };
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

/**
 * §15.6 远程图片下载（ENEX 与 HTML 导出共用同一管线）：各请求相互独立，
 * 并行执行以免逐张串行累加网络延迟；失败按张计数，由调用方记降级。
 */
async function downloadRemoteImages(
  remotes: readonly { url: string }[],
  cfg: EvernoteSourceConfig,
): Promise<{ assets: SourceAsset[]; okCount: number; failCount: number }> {
  const results = await Promise.all(
    remotes.map((remote) =>
      downloadImage({ url: remote.url, maxBytes: cfg.assets.maxImageBytes, maxRetries: 1 }),
    ),
  );
  const assets: SourceAsset[] = [];
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < remotes.length; i += 1) {
    const r = results[i];
    if (r.ok) {
      okCount += 1;
      assets.push({
        originalUrl: remotes[i].url,
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
  return { assets, okCount, failCount };
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
  /**
   * §15.10 两遍处理第一遍的索引：GUID → {title, fingerprint}。
   * scan 阶段（job-runner 先完整扫描后提取）累积；跨进程 resume 时适配器是
   * 新实例、映射为空——首次 extract 懒重建（ensureGuidMap），内部链接不降级。
   */
  const guidMap = new Map<string, { title: string; fingerprint: string }>();
  /**
   * 映射就绪承诺：缓存进行中的重建，并发 extract 共享同一次重建而非各自空跑；
   * 失败时清空，下次调用可重试（不缓存半成品映射）。
   */
  let guidMapReady: Promise<void> | undefined;
  /**
   * §15.3 大文件顺序提取游标：文件 → 已解析到的换行对齐字节边界。
   * job-runner 按扫描顺序提取 → 单调推进 → 每文件总读取 ≈ 一次全量 + 每条一块。
   * 回退（重试/乱序）自动从文件头重读，正确性不受影响。
   */
  const cursors = new Map<string, import('../enex/sax-notes.js').StreamCursor>();

  /** 懒重建 GUID 映射：流式重读全部 ENEX 的轻量头（仅当 scan 未构建过）。 */
  const ensureGuidMap = (workspaceDir: string): Promise<void> => {
    if (guidMapReady === undefined) {
      guidMapReady = (async () => {
        const inputRoots = resolveInputPaths(cfg.inputPaths, workspaceDir);
        const { files } = await collectEnexFiles(inputRoots, cfg.stackSeparator, {
          includeHtml: cfg.formats.includes('html'),
        });
        for (const file of files) {
          await streamNotes(file.path, {
            headerOnly: true,
            onNote: (n) => {
              if (n.guid === undefined) return;
              guidMap.set(n.guid.toLowerCase(), guidMapEntryOf(file, n));
            },
          });
        }
      })().catch((err: unknown) => {
        guidMapReady = undefined; // 失败不缓存半成品映射，允许下次重试
        throw err;
      });
    }
    return guidMapReady;
  };

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
        notebookMappings: cfg.notebookMappings,
      });
    },

    async *scan(ctx): AsyncGenerator<SourceItemRef> {
      scanState.issues = [];
      scanState.skippedInputs = [];
      guidMap.clear();
      guidMapReady = undefined;
      const inputRoots = resolveInputPaths(cfg.inputPaths, ctx.workspaceDir);
      const includeHtml = cfg.formats.includes('html');
      const { files, htmlFiles, skipped, warnings } = await collectEnexFiles(
        inputRoots,
        cfg.stackSeparator,
        { includeHtml, notebookMappings: cfg.notebookMappings },
      );
      scanState.skippedInputs = skipped;
      scanState.issues.push(...warnings);

      for (const file of files) {
        const notes: Array<{
          ordinal: number;
          title: string;
          created: RawNote['created'];
          guid: string | undefined;
        }> = [];
        const outcome = await streamNotes(file.path, {
          headerOnly: true,
          onNote: (n) =>
            notes.push({
              ordinal: n.ordinal,
              title: n.title,
              created: n.created,
              guid: n.guid,
            }),
          onIssue: (msg) => scanState.issues.push(`${file.baseName}.enex: ${msg}`),
        });
        if (outcome.error !== undefined) {
          // §15.3 损坏隔离：已读出的笔记照常产出；错误记录供诊断，文件级继续
          scanState.issues.push(`${file.path}: ${outcome.error.message}（已读出 ${notes.length} 条）`);
        }
        for (const n of notes) {
          const refTitle = n.title.length > 0 ? n.title : `未命名笔记 #${n.ordinal}`;
          const { externalId, fingerprint } = buildNoteIdentity({
            guid: n.guid,
            fileSha256: file.sha256,
            ordinal: n.ordinal,
            title: n.title,
            createdIso: enexTimeToIso(n.created),
            fileBaseName: file.baseName,
          });
          if (n.guid !== undefined) {
            guidMap.set(n.guid.toLowerCase(), guidMapEntryOf(file, n));
          }
          const meta: EnexRefMetadata = {
            path: file.path,
            baseName: file.baseName,
            ordinal: n.ordinal,
            fileSha256: file.sha256,
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            notebook: file.notebook,
            stack: file.stack,
            notebookKey: file.notebookKey,
            notePathSegments: buildNotePathSegments(file.notebook, file.notebookKey, file.stack, cfg.notebookShortId),
            ...(n.guid !== undefined ? { guid: n.guid.toLowerCase() } : {}),
          };
          yield {
            sourceInstanceId: cfg.sourceInstanceId,
            externalId,
            title: refTitle,
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
          let htmlRef: SourceItemRef;
          try {
            const exportRoot = exportRootFor(htmlPath, inputRoots);
            const header = scanHtmlNote(htmlPath, exportRoot);
            const fingerprint = computeFingerprint({
              raw: [header.fileSha256, header.title].join('\0'),
            });
            // §15.5 notebookKey 对 HTML 导出按目录维度推导（目录路径 + 笔记本名）
            const relDir = dirname(header.relPath);
            const htmlNotebookKey = createHash('sha256')
              .update(`${relDir}\0${header.notebook}`)
              .digest('hex');
            htmlRef = {
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
                  notePathSegments: buildNotePathSegments(header.notebook, htmlNotebookKey, undefined, cfg.notebookShortId),
                },
              },
            };
          } catch (err) {
            // §15.3 损坏隔离：HTML 文件不可读/解析失败时记录问题，文件级继续
            scanState.issues.push(`${htmlPath}: ${(err as Error).message}`);
            continue;
          }
          yield htmlRef;
        }
      }
      // scan 已完整构建 GUID 映射；后续 extract 不再懒重建
      guidMapReady = Promise.resolve();
    },

    async extract(ref, ctx): Promise<SourceItem> {
      const meta = refMetaOf(ref);

      // §15.10：跨进程 resume（新适配器实例）首次 extract 时懒重建 GUID 映射
      await ensureGuidMap(ctx.workspaceDir);

      // §15.3 完整性：扫描与提取之间文件被修改即失败（指纹输入含文件哈希，静默继续会错账）。
      // 大文件（GB 级）逐条全文件 SHA 不可行：size+mtime 未变走快速路径，变化再算 SHA 终判。
      const filePath = meta.enex?.path ?? meta.html?.path;
      const expectedSha = meta.enex?.fileSha256 ?? meta.html?.fileSha256;
      if (filePath === undefined || expectedSha === undefined) {
        throw new Error(
          `ref ${ref.externalId} 的 sourceMetadata 缺少文件路径/哈希（非本适配器产出的 ref）`,
        );
      }
      let integrityOk = false;
      if (meta.enex !== undefined) {
        try {
          const st = statSync(filePath);
          if (st.size === meta.enex.sizeBytes && st.mtimeMs === meta.enex.mtimeMs) {
            integrityOk = true;
          }
        } catch {
          // stat 失败走 SHA 路径给出准确错误
        }
      }
      if (!integrityOk) {
        const currentSha = await sha256FileQuick(filePath);
        if (currentSha !== expectedSha) {
          throw new Error(
            `导出文件在扫描后被修改：${filePath}（期望 ${expectedSha.slice(0, 8)}，实际 ${currentSha.slice(0, 8)}），请重新扫描`,
          );
        }
      }

      // §15.12 HTML 导出分派
      if (meta.html !== undefined) {
        return extractHtmlAsItem(ref, meta.html, cfg);
      }
      const enexMeta = meta.enex;
      if (enexMeta === undefined) {
        throw new Error(
          `ref ${ref.externalId} is missing sourceMetadata.enex/.html (not produced by this adapter)`,
        );
      }

      let raw: RawNote | undefined;
      const prevCursor = cursors.get(enexMeta.path) ?? { ordinal: 0, offset: 0 };
      // 回退保护：目标序号 ≤ 游标（重试/乱序）时从文件头重读
      const useCursor =
        enexMeta.ordinal > prevCursor.ordinal ? prevCursor : { ordinal: 0, offset: 0 };
      const outcome = await streamNotes(enexMeta.path, {
        startOffset: useCursor.offset,
        ordinalBase: useCursor.ordinal,
        stopAfterOrdinal: enexMeta.ordinal,
        onNote: (n) => {
          if (n.ordinal === enexMeta.ordinal) raw = n;
        },
      });
      if (outcome.cursor !== undefined && outcome.cursor.ordinal >= useCursor.ordinal) {
        cursors.set(enexMeta.path, outcome.cursor);
      }
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
      // §15.10 第二遍：GUID → evernote-wikilink://<指纹>/<编码标题> 伪链接。
      // 携带稳定身份（指纹）而非最终文件名——目标端按自己的命名布局
      // （filenameShortId 开关）解析出真实文件名，布局解耦。
      const resolveGuidLink = (guid: string): string | undefined => {
        const target = guidMap.get(guid.toLowerCase());
        if (target === undefined) return undefined;
        const fp = target.fingerprint.replace(/^sha256:/, '');
        return `${fp}/${encodeURIComponent(target.title)}`;
      };
      const transform = enmlToHtml(note.content ?? '', resourceByMd5, { resolveGuidLink });

      // §15.6 远程图片下载（与 §12.10 同一管线；默认关闭不发起网络请求）
      const assets = processed.resources.map((r) => r.asset);
      const degradations: SourceItem['degradations'] = [];
      const warnings: string[] = [];
      if (cfg.assets.downloadImages && transform.remoteImages.length > 0) {
        const { assets: downloaded, okCount, failCount } = await downloadRemoteImages(
          transform.remoteImages,
          cfg,
        );
        assets.push(...downloaded);
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
      if (transform.internalLinks.length > 0 || transform.resolvedInternalLinks > 0) {
        warnings.push(
          `内部链接：重写 ${transform.resolvedInternalLinks}，未解析 ${transform.internalLinks.length}（保留原始链接，§15.10）`,
        );
        // §15.10 明细（job-runner 汇入报告 unresolved-links.csv）
        for (const l of transform.internalLinks.slice(0, 20)) {
          warnings.push(`未解析内部链接：${l.text.length > 0 ? l.text : '(无文字)'} → ${l.url}`);
        }
        if (transform.internalLinks.length > 20) {
          warnings.push(`未解析内部链接：… 等共 ${transform.internalLinks.length} 条`);
        }
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
        notePathSegments: enexMeta.notePathSegments,
        notebook: enexMeta.notebook,
        stack: enexMeta.stack,
        source_type: attrs.source,
        source_url: sourceUrl,
        reminder_order: attrs['reminder-order'],
        content_class: attrs['content-class'],
        enml_todo_count: transform.todoCount,
        // §15.8 地理位置（显式启用时保留；含 place-name）
        ...(cfg.includeGeolocation && attrs.latitude !== undefined
          ? {
              latitude: attrs.latitude,
              ...(attrs.longitude !== undefined ? { longitude: attrs.longitude } : {}),
              ...(attrs.altitude !== undefined ? { altitude: attrs.altitude } : {}),
              ...(attrs['place-name'] !== undefined
                ? { place_name: attrs['place-name'] }
                : {}),
            }
          : {}),
      };

      // §15.8 updatedAt 缺失时回退 createdAt
      const effectiveUpdatedAt = updatedIso ?? createdIso;

      return {
        ref,
        title: ref.title ?? (note.title.length > 0 ? note.title : '未命名笔记'),
        ...(attrs.author !== undefined ? { author: attrs.author } : {}),
        ...(createdIso !== undefined ? { createdAt: createdIso } : {}),
        ...(effectiveUpdatedAt !== undefined ? { updatedAt: effectiveUpdatedAt } : {}),
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
    const { assets: downloaded, okCount, failCount } = await downloadRemoteImages(
      result.remoteImages,
      cfg,
    );
    assets.push(...downloaded);
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
      notePathSegments: meta.notePathSegments,
      notebook: meta.notebook,
    },
  };
}

export type { EnexFileInfo, ProcessedResource };
