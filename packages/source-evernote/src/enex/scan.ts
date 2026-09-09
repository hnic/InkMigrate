import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, lstatSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

/**
 * §15.2/§15.2.1/§15.5 输入收集与文件级元数据。
 *
 * - `.enex` 文件（含目录递归）进入迁移清单。
 * - `.notes`（印象笔记专有加密格式）出现即显式失败：抛 EvernoteNotesRejectedError，
 *   错误信息含 PRD §15.2.1 的三条替代导出指引，不得静默跳过。
 * - `.html`/其他后缀跳过（HTML 导出解析为后续增量），记入 skipped 供报告。
 * - 每文件计算 SHA-256（§15.3 扫描清单），笔记本/Stack 从文件名推断（§15.5）。
 */

/** §15.2.1 印象笔记 .notes 拒绝错误：显式失败 + 替代导出指引。 */
export class EvernoteNotesRejectedError extends Error {
  constructor(public readonly files: string[]) {
    super(
      [
        `检测到 ${files.length} 个印象笔记专有 .notes 导出文件，InkMigrate 不支持该格式（内容为未公开密钥的 AES 加密，PRD §15.2.1）：`,
        ...files.slice(0, 10).map((f) => `  - ${f}`),
        ...(files.length > 10 ? [`  ... 等共 ${files.length} 个`] : []),
        '替代导出方式：',
        '  1. 新版印象笔记客户端导出 HTML（当前唯一开放格式，解析支持即将提供）；',
        '  2. 使用 evernote-backup --backend china 通过账号同步导出 ENEX，再交给 InkMigrate；',
        '  3. 旧版客户端导出 ENEX（兼容性随时间衰减，仅作最后手段）。',
      ].join('\n'),
    );
    this.name = 'EvernoteNotesRejectedError';
  }
}

export interface EnexFileInfo {
  /** 绝对路径。 */
  path: string;
  /** 不含扩展名的文件名（笔记本推断输入）。 */
  baseName: string;
  /** §15.5 从 `Stack@@@Notebook.enex` 命名拆出的 Stack；无分隔符时 undefined。 */
  stack?: string | undefined;
  /** §15.5 笔记本名（默认取文件名主体）。 */
  notebook: string;
  /** §15.5 notebookKey = SHA-256(exportFileHash + NUL + stack + NUL + notebook)。 */
  notebookKey: string;
  /** 文件内容 SHA-256（hex）。 */
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** §15.5 用户映射清单（键 = ENEX 文件名，带/不带 .enex 后缀均可；stack null = 清除推断值）。 */
export interface NotebookMapping {
  stack?: string | null | undefined;
  notebook?: string | undefined;
  mergeKey: string | null;
}
export type NotebookMappings = Record<string, NotebookMapping>;

export interface CollectInputResult {
  files: EnexFileInfo[];
  /** §15.12 HTML 导出文件（绝对路径；仅 includeHtml 时收集，供报告提示）。 */
  htmlFiles: string[];
  /** 跳过的其余文件（不支持的格式），供报告提示。 */
  skipped: string[];
  /** §15.5 无 Stack 提示、映射键未命中等非致命警告（进扫描报告）。 */
  warnings: string[];
}

/** `.resources`/`_resources` 是 §15.12 笔记附属资源目录，不作为笔记来源递归。 */
function isResourcesDir(name: string): boolean {
  return name.endsWith('.resources') || name === '_resources';
}

type ExportKind = 'enex' | 'notes' | 'html' | 'other';

/** 统一的扩展名分类：walk() 目录遍历与 collectEnexFiles() 直接文件输入共用，避免两份逻辑漂移。 */
function classifyExportFile(name: string, includeHtml: boolean): ExportKind {
  const ext = extname(name).toLowerCase();
  if (ext === '.enex') return 'enex';
  if (ext === '.notes') return 'notes';
  if (ext === '.html' && includeHtml) return 'html';
  return 'other';
}

/** 递归收集 .enex/.notes/.html 文件；符号链接一律跳过（防路径逃逸）。
 * dirStack：子文件的缺省 Stack——evernote-backup 导出把 Stack 输出为目录
 * （`<Stack>/<笔记本>.enex`，§15.5 目录约定），文件名 Stack@@@ 分隔符仍优先。 */
function walk(
  root: string,
  enex: string[],
  notes: string[],
  html: string[],
  skipped: string[],
  includeHtml: boolean,
  dirStack: string | undefined,
  dirStackByFile: Map<string, string | undefined>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 权限错误意味着目录内容未知（其中可能藏有 .notes），按 §15.2.1 显式失败，
    // 不得静默跳过——skip 记录比抛错更容易被漏看
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `无法读取目录 ${root}（${code}）：无法确认其中是否包含 .notes 导出文件，请修正目录权限后重试`,
      );
    }
    skipped.push(`${root}/ (不可读: ${code ?? 'unknown'})`);
    return;
  }
  // 排序保证扫描顺序确定（同目录下按名字），重跑幂等
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = resolve(root, e.name);
    if (e.isSymbolicLink()) {
      skipped.push(`${full} (符号链接跳过)`);
      continue;
    }
    if (e.isDirectory()) {
      if (isResourcesDir(e.name)) continue;
      walk(full, enex, notes, html, skipped, includeHtml, e.name, dirStackByFile);
      continue;
    }
    if (!e.isFile()) continue;
    switch (classifyExportFile(e.name, includeHtml)) {
      case 'enex':
        enex.push(full);
        dirStackByFile.set(full, dirStack);
        break;
      case 'notes':
        notes.push(full);
        break;
      case 'html':
        html.push(full);
        break;
      default:
        skipped.push(full);
    }
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 收集输入路径下的 ENEX 文件并计算文件级元数据。
 * 传入的 inputPaths 已由调用方解析为绝对路径。
 * 存在 .notes 输入时抛 EvernoteNotesRejectedError（§15.2.1 显式失败）。
 */
export async function collectEnexFiles(
  inputPaths: readonly string[],
  stackSeparator: string,
  opts: { includeHtml?: boolean; notebookMappings?: NotebookMappings } = {},
): Promise<CollectInputResult> {
  const includeHtml = opts.includeHtml ?? false;
  const mappings = opts.notebookMappings ?? {};
  const enexPaths: string[] = [];
  const notesPaths: string[] = [];
  const htmlPaths: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const dirStackByFile = new Map<string, string | undefined>();

  for (const p of inputPaths) {
    let st;
    try {
      // lstat：入口本身是符号链接时按不可用跳过，不跟随
      st = lstatSync(p);
    } catch {
      skipped.push(`${p} (不存在或不可访问)`);
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.push(`${p} (符号链接跳过)`);
      continue;
    }
    if (st.isDirectory()) {
      walk(p, enexPaths, notesPaths, htmlPaths, skipped, includeHtml, undefined, dirStackByFile);
    } else if (st.isFile()) {
      switch (classifyExportFile(p, includeHtml)) {
        case 'enex':
          enexPaths.push(p);
          dirStackByFile.set(p, undefined); // 输入根直连文件：无目录 Stack
          break;
        case 'notes':
          notesPaths.push(p);
          break;
        case 'html':
          htmlPaths.push(p);
          break;
        default:
          skipped.push(p);
      }
    } else {
      skipped.push(`${p} (非普通文件)`);
    }
  }

  if (notesPaths.length > 0) {
    throw new EvernoteNotesRejectedError(notesPaths);
  }

  enexPaths.sort((a, b) => a.localeCompare(b, 'en'));
  interface Draft {
    path: string;
    baseName: string;
    stack: string | undefined;
    notebook: string;
    mergeKey: string | null;
    sizeBytes: number;
    mtimeMs: number;
  }
  const drafts: Draft[] = [];
  const matchedMappingKeys = new Set<string>();
  for (const p of enexPaths) {
    let st: Stats;
    try {
      // lstat：walk 后文件被删除或被替换为符号链接时不跟随（防路径逃逸/TOCTOU），
      // 不可访问的文件记入 skipped 文件级继续，与遍历阶段的隔离行为一致
      st = lstatSync(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      skipped.push(`${p} (扫描后不可访问${code !== undefined ? `: ${code}` : ''})`);
      continue;
    }
    if (!st.isFile()) {
      skipped.push(`${p} (非普通文件)`);
      continue;
    }
    const baseName = basename(p, extname(p));
    let { stack, notebook } = splitStackNotebook(baseName, stackSeparator);
    // evernote-backup Stack 目录约定：文件名无 Stack 分隔符时取父目录名
    if (stack === undefined) stack = dirStackByFile.get(p);
    // §15.5 用户映射覆盖（键接受带/不带 .enex 后缀）
    const mapping =
      mappings[baseName] !== undefined ? mappings[baseName] : mappings[`${baseName}.enex`];
    let mergeKey: string | null = null;
    if (mapping !== undefined) {
      matchedMappingKeys.add(
        mappings[baseName] !== undefined ? baseName : `${baseName}.enex`,
      );
      if (mapping.stack !== undefined) stack = mapping.stack ?? undefined;
      if (mapping.notebook !== undefined) notebook = mapping.notebook;
      mergeKey = mapping.mergeKey;
    } else if (stack === undefined) {
      // §15.5 默认导出缺少 Stack 信息时报告必须说明无法自动还原
      warnings.push(
        `${baseName}.enex：无 Stack 信息，无法自动还原笔记本组层级（可用 notebookMappings 手动指定）`,
      );
    }
    drafts.push({
      path: p,
      baseName,
      stack,
      notebook,
      mergeKey,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  for (const key of Object.keys(mappings)) {
    if (!matchedMappingKeys.has(key)) {
      warnings.push(`notebookMappings 键 "${key}" 未匹配任何输入文件`);
    }
  }
  // §15.5 mergeKey 非空必须经过配置验证：同组最终笔记本名必须一致（含 Stack）
  const groups = new Map<string, { notebook: string; stack: string | undefined }>();
  for (const d of drafts) {
    if (d.mergeKey === null) continue;
    const prev = groups.get(d.mergeKey);
    if (prev !== undefined && (prev.notebook !== d.notebook || prev.stack !== d.stack)) {
      throw new Error(
        `notebookMappings 校验失败：mergeKey "${d.mergeKey}" 组内笔记本不一致` +
          `（${[prev.stack, prev.notebook].filter(Boolean).join('/')} vs ${[d.stack, d.notebook].filter(Boolean).join('/')}）；合并前请先统一 stack/notebook 映射`,
      );
    }
    if (prev === undefined) groups.set(d.mergeKey, { notebook: d.notebook, stack: d.stack });
  }
  // mergeKey 组共享 notebookKey（同组落同一笔记本目录）；否则按文件哈希派生
  const mergeKeys = new Map<string, string>();
  for (const [mk, info] of groups) {
    mergeKeys.set(
      mk,
      createHash('sha256').update(`merge\0${mk}\0${info.stack ?? ''}\0${info.notebook}`).digest('hex'),
    );
  }
  // 各文件的 SHA-256 相互独立：并行计算并用固定并发上限约束句柄/内存占用
  // （大导出数百个 .enex 时避免逐文件串行浪费 I/O 与 CPU 重叠）；
  // 单文件读取失败记入 skipped，文件级继续
  const HASH_CONCURRENCY = 8;
  const shas = new Map<string, string>();
  for (let i = 0; i < drafts.length; i += HASH_CONCURRENCY) {
    await Promise.all(
      drafts.slice(i, i + HASH_CONCURRENCY).map(async (d) => {
        try {
          shas.set(d.path, await sha256File(d.path));
        } catch (err) {
          skipped.push(`${d.path} (读取失败: ${(err as Error).message})`);
        }
      }),
    );
  }
  const files: EnexFileInfo[] = [];
  for (const d of drafts) {
    const sha = shas.get(d.path);
    if (sha === undefined) continue; // 读取失败的已记入 skipped
    files.push({
      path: d.path,
      baseName: d.baseName,
      stack: d.stack,
      notebook: d.notebook,
      notebookKey:
        d.mergeKey !== null
          ? (mergeKeys.get(d.mergeKey)!)
          : createHash('sha256').update(`${sha}\0${d.stack ?? ''}\0${d.notebook}`).digest('hex'),
      sha256: sha,
      sizeBytes: d.sizeBytes,
      mtimeMs: d.mtimeMs,
    });
  }
  return {
    files,
    htmlFiles: htmlPaths.sort((a, b) => a.localeCompare(b, 'en')),
    skipped,
    warnings,
  };
}

/** §15.5 文件名 → Stack/笔记本；无分隔符时整体作为笔记本名。 */
export function splitStackNotebook(
  baseName: string,
  separator: string,
): { stack?: string | undefined; notebook: string } {
  const idx = baseName.indexOf(separator);
  // 守卫保证分隔符两侧均有内容（空分隔符时 indexOf 返回 0，同样被 idx <= 0 拦截）；
  // 仅按第一个分隔符拆分（`Stack@@@Notebook` 命名约定，后续分隔符归笔记本名）
  if (idx <= 0 || idx >= baseName.length - separator.length) {
    return { notebook: baseName };
  }
  return {
    stack: baseName.slice(0, idx),
    notebook: baseName.slice(idx + separator.length),
  };
}

/** 相对输入路径锚定 workspaceDir（绝对路径原样保留）。 */
export function resolveInputPaths(
  inputPaths: readonly string[],
  workspaceDir: string,
): string[] {
  return inputPaths.map((p) => resolve(workspaceDir, p));
}
