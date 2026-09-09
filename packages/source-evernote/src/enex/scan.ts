import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, lstatSync } from 'node:fs';
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

export interface CollectInputResult {
  files: EnexFileInfo[];
  /** 跳过的非 .enex 文件（.html 等），供报告提示。 */
  skipped: string[];
}

/** 递归收集 .enex/.notes 文件；符号链接一律跳过（防路径逃逸）。 */
function walk(root: string, enex: string[], notes: string[], skipped: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    skipped.push(`${root}/ (不可读)`);
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
      walk(full, enex, notes, skipped);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (ext === '.enex') enex.push(full);
    else if (ext === '.notes') notes.push(full);
    else skipped.push(full);
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
): Promise<CollectInputResult> {
  const enexPaths: string[] = [];
  const notesPaths: string[] = [];
  const skipped: string[] = [];

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
      walk(p, enexPaths, notesPaths, skipped);
    } else if (st.isFile()) {
      const ext = extname(p).toLowerCase();
      if (ext === '.enex') enexPaths.push(p);
      else if (ext === '.notes') notesPaths.push(p);
      else skipped.push(p);
    } else {
      skipped.push(`${p} (非普通文件)`);
    }
  }

  if (notesPaths.length > 0) {
    throw new EvernoteNotesRejectedError(notesPaths);
  }

  enexPaths.sort((a, b) => a.localeCompare(b, 'en'));
  const files: EnexFileInfo[] = [];
  for (const p of enexPaths) {
    const baseName = basename(p, extname(p));
    const { stack, notebook } = splitStackNotebook(baseName, stackSeparator);
    const st = statSync(p);
    const sha = await sha256File(p);
    files.push({
      path: p,
      baseName,
      stack,
      notebook,
      notebookKey: createHash('sha256')
        .update(`${sha}\0${stack ?? ''}\0${notebook}`)
        .digest('hex'),
      sha256: sha,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  return { files, skipped };
}

/** §15.5 文件名 → Stack/笔记本；无分隔符时整体作为笔记本名。 */
export function splitStackNotebook(
  baseName: string,
  separator: string,
): { stack?: string | undefined; notebook: string } {
  const idx = baseName.indexOf(separator);
  if (idx <= 0 || idx >= baseName.length - separator.length) {
    return { notebook: baseName };
  }
  const stack = baseName.slice(0, idx);
  const notebook = baseName.slice(idx + separator.length);
  if (stack.length === 0 || notebook.length === 0) return { notebook: baseName };
  return { stack, notebook };
}

/** 相对输入路径锚定 workspaceDir（绝对路径原样保留）。 */
export function resolveInputPaths(
  inputPaths: readonly string[],
  workspaceDir: string,
): string[] {
  return inputPaths.map((p) => resolve(workspaceDir, p));
}
