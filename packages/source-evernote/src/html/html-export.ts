import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  assertSymlinkSafe,
  isPathInside,
  sanitizeFilename,
  type SourceAsset,
  type SourceLink,
} from '@inkmigrate/core';
import { assetKindOf, MAX_RESOURCE_FILENAME_LENGTH, sniffMime } from '../resources/process-resources.js';
import { sanitizeNoteHtml } from '../enml/enml-to-html.js';

/**
 * §15.12 HTML 导出解析（印象笔记中国版用户的一等输入路径）。
 *
 * 典型结构：每条笔记一个 `.html` + 同名 `.resources/`（或 `_resources`）子目录，
 * 多笔记本导出时按笔记本分目录；结构随客户端版本有差异——不依赖固定命名，
 * 资源以 HTML 内的相对引用定位（§15.12）。
 *
 * 安全：jsdom 以 outside-only 解析（不执行脚本）；HTML 经 DOMPurify 清洗；
 * 资源引用只允许解析到导出根内（拒 traversal 与符号链接）。
 * 本地资源以 `evernote-resource://<sha256前16位>` 合成 URI 进正文与
 * asset.originalUrl——与 ENEX 的 enex-resource:// 同机制复用目标端本地化。
 */

/** HTML 资源合成 URI 前缀（区别于 ENEX 资源，便于诊断区分来源）。 */
export const evernoteResourceUri = (sha256Hex: string): string =>
  `evernote-resource://${sha256Hex.slice(0, 16)}`;

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

export interface HtmlNoteHeader {
  /** 绝对路径。 */
  path: string;
  /** 相对导出根的路径（externalId 组成部分，搬移目录不影响已入库身份）。 */
  relPath: string;
  fileSha256: string;
  title: string;
  /** §15.12 由目录结构推断：父目录名（非 resources 目录）；根层级回退导出根目录名。 */
  notebook: string;
  /** 同名 .resources/ 子目录（存在时）。 */
  resourcesDir?: string | undefined;
}

/** 从已解析的文档提取标题：<title> → h1 → 空串（调用方回退文件名）。
 * 同时返回命中的 h1 节点供调用方移除（标题不重复进正文）；
 * extractTitleFromHtml 与 extractHtmlNote 共用，避免回退链两处漂移。 */
function extractTitleFromDocument(doc: Document): { title: string; h1: Element | null } {
  const t = doc.querySelector('title')?.textContent?.trim();
  if (t !== undefined && t.length > 0) return { title: t, h1: doc.querySelector('h1') };
  const h1 = doc.querySelector('h1');
  return { title: h1?.textContent?.trim() ?? '', h1 };
}

/** 从 HTML 文本提取标题（<title> 优先，回退 h1）。 */
export function extractTitleFromHtml(html: string): string {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  return extractTitleFromDocument(dom.window.document).title;
}

/** 轻量头信息：标题 + 笔记本推断 + resources 目录探测 + 文件哈希。 */
export function scanHtmlNote(
  path: string,
  exportRoot: string,
): HtmlNoteHeader {
  // 哈希原始字节而非 UTF-8 解码文本：readFileSync(utf8) 对无效字节序列有损
  // （替换为 U+FFFD），两个不同文件可能解码出同一字符串 → 身份哈希碰撞
  const raw = readFileSync(path);
  const fileSha256 = createHash('sha256').update(raw).digest('hex');
  const html = raw.toString('utf8');
  const base = basename(path, '.html');
  const dir = dirname(path);
  const parentName = basename(dir);
  const notebook = isResourcesDirName(parentName)
    ? basename(exportRoot)
    : parentName;
  const resourcesDir = detectResourcesDir(dir, base);
  return {
    path,
    relPath: relative(exportRoot, path) || base,
    fileSha256,
    title: extractTitleFromHtml(html) || base,
    notebook,
    resourcesDir,
  };
}

function isResourcesDirName(name: string): boolean {
  return name.endsWith('.resources') || name === '_resources';
}

function detectResourcesDir(dir: string, noteBase: string): string | undefined {
  for (const candidate of [`${noteBase}.resources`, `${noteBase}_resources`, '_resources']) {
    const p = resolve(dir, candidate);
    try {
      if (lstatSync(p).isDirectory()) return p;
    } catch {
      // 不存在，继续探测
    }
  }
  return undefined;
}

export interface HtmlExtractResult {
  bodyHtml: string;
  assets: SourceAsset[];
  links: SourceLink[];
  /** 解析到导出根内并成功读取的本地资源数。 */
  resolvedResources: number;
  /** 引用了但文件不存在/在导出根外的资源数（进降级）。 */
  missingResources: number;
  externalLinksCount: number;
  /** 正文中的远程 <img>（http/https；§15.6 下载管线，未启用时保留远程链接）。 */
  remoteImages: Array<{ url: string; alt?: string | undefined }>;
}

/**
 * 完整解析一条 HTML 笔记：正文清洗 + 本地资源字节化 + 链接收集。
 * exportRoot 用于资源边界校验（引用逃逸或符号链接一律按缺失处理，§15.12）。
 */
export function extractHtmlNote(path: string, exportRoot: string): HtmlExtractResult {
  const html = readFileSync(path, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', resources: undefined });
  const doc = dom.window.document;
  const noteDir = dirname(path);

  const result: HtmlExtractResult = {
    bodyHtml: '',
    assets: [],
    links: [],
    resolvedResources: 0,
    missingResources: 0,
    externalLinksCount: 0,
    remoteImages: [],
  };
  const seenSha = new Set<string>();
  const seenNames = new Set<string>();
  const markAttr = 'data-ink-resource';

  /** 尝试把相对引用解析为导出根内的真实文件；失败返回 null。
   * 大小写不敏感地拦截一切带 scheme（http/evernote/data/cid/file 等）或
   * 协议相对（//host/...）的引用：它们不是文件系统路径，落进 resolve 只会
   * 把合法引用误判成「资源缺失」。 */
  const resolveLocal = (ref: string): string | null => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) {
      return null;
    }
    // 剥离 ?query/#fragment 后解码；非法百分号编码（如 src="file%zz.png"）按缺失处理
    let decoded: string;
    try {
      // ?? ref：noUncheckedIndexedAccess 下 [0] 可能是 undefined（split 实际
      // 恒非空，此处仅为类型完备）
      decoded = decodeURIComponent(ref.split(/[?#]/)[0] ?? ref);
    } catch {
      return null;
    }
    const abs = resolve(noteDir, decoded);
    if (!isPathInside(abs, exportRoot)) return null;
    try {
      const st = lstatSync(abs);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      assertSymlinkSafe(exportRoot, abs);
      return abs;
    } catch {
      return null;
    }
  };

  // 同一文件的重复引用只读取/哈希一次，共用同一 asset 与 URI；
  // 同内容（SHA-256 相同）经不同路径引用时也复用同一 asset——fileName 唯一，
  // 引用占位（attachment:<fileName>）才不会指向不存在的清单条目
  const assetByPath = new Map<string, { asset: SourceAsset; uri: string }>();
  const assetBySha = new Map<string, { asset: SourceAsset; uri: string }>();
  const buildAsset = (abs: string): { asset: SourceAsset; uri: string } => {
    const cached = assetByPath.get(abs);
    if (cached !== undefined) return cached;
    const bytes = readFileSync(abs);
    const sha256Hex = createHash('sha256').update(bytes).digest('hex');
    const bySha = assetBySha.get(sha256Hex);
    if (bySha !== undefined) {
      assetByPath.set(abs, bySha);
      return bySha;
    }
    const sniffed = sniffMime(new Uint8Array(bytes));
    const ext = extname(abs).toLowerCase();
    const mime = sniffed ?? EXT_MIME[ext] ?? 'application/octet-stream';
    let fileName = sanitizeFilename(basename(abs), { maxLength: MAX_RESOURCE_FILENAME_LENGTH });
    if (seenNames.has(fileName.toLowerCase())) {
      // sha8 后缀名仍可能撞上已占用名（另一资源恰好叫 stem-<同sha8>），循环直到唯一
      const stem = fileName.replace(/\.[^.]+$/, '');
      let candidate = `${stem}-${sha256Hex.slice(0, 8)}${ext}`;
      let n = 1;
      while (seenNames.has(candidate.toLowerCase())) {
        n += 1;
        candidate = `${stem}-${sha256Hex.slice(0, 8)}-${n}${ext}`;
      }
      fileName = candidate;
    }
    seenNames.add(fileName.toLowerCase());
    const built = {
      asset: {
        externalId: sha256Hex.slice(0, 32),
        originalUrl: evernoteResourceUri(sha256Hex),
        mimeType: mime,
        byteSize: bytes.length,
        sha256: `sha256:${sha256Hex}`,
        kind: assetKindOf(mime),
        fileName,
        data: new Uint8Array(bytes),
      },
      uri: evernoteResourceUri(sha256Hex),
    };
    assetByPath.set(abs, built);
    assetBySha.set(sha256Hex, built);
    return built;
  };

  // 源 HTML 自带的同名标记一律先清除：PASS 2 按该属性选择元素并把值写入
  // img.src，未受控的预置值（恶意/畸形导出）会把任意 URI 注入正文
  for (const el of [...doc.querySelectorAll(`[${markAttr}]`)]) {
    el.removeAttribute(markAttr);
  }

  // PASS 1（未清洗 DOM）：定位本地资源引用并标记，收集外链
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    if (src === null) continue;
    if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
      // 远程图片（含协议相对 //host/...，补全 https）保留原链接（§15.6 下载管线）
      result.remoteImages.push({
        url: src.startsWith('//') ? `https:${src}` : src,
        alt: img.getAttribute('alt') ?? undefined,
      });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // data:/cid:/file: 等内联或非文件引用：无需本地文件，不计缺失不重写
      continue;
    }
    const abs = resolveLocal(src);
    if (abs === null) {
      result.missingResources += 1;
      img.setAttribute(markAttr, 'missing');
      continue;
    }
    const { asset, uri } = buildAsset(abs);
    // 先标记：去重命中的引用也要重写 src（否则重复引用保留失效的相对路径）
    img.setAttribute(markAttr, uri);
    if (seenSha.has(asset.sha256!)) continue; // 同内容去重（引用走同一 URI）
    seenSha.add(asset.sha256!);
    result.assets.push(asset);
    result.resolvedResources += 1;
  }

  for (const a of [...doc.querySelectorAll('a')]) {
    const href = a.getAttribute('href');
    if (href === null) continue;
    if (/^https?:\/\//i.test(href)) {
      result.links.push({ url: href, text: (a.textContent ?? '').trim(), kind: 'external' });
      result.externalLinksCount += 1;
      continue;
    }
    if (/^evernote:\/\//i.test(href)) {
      result.links.push({ url: href, text: (a.textContent ?? '').trim(), kind: 'internal' });
      continue;
    }
    const abs = resolveLocal(href);
    if (abs === null) continue; // 锚点等非资源引用不动
    // 笔记间 .html 链接（多笔记本 HTML 导出常见）保留链接语义记为内部链接，
    // 不把目标笔记整文件吞成附件（正文导航被毁 + 内容重复进资产库）
    if (/\.html?$/i.test(abs)) {
      result.links.push({ url: href, text: (a.textContent ?? '').trim(), kind: 'internal' });
      continue;
    }
    const { asset } = buildAsset(abs);
    if (!seenSha.has(asset.sha256!)) {
      seenSha.add(asset.sha256!);
      result.assets.push(asset);
      result.resolvedResources += 1;
    }
    // §15.7.5：附件不改写正文位置 → 标记为附件引用占位
    a.setAttribute(markAttr, `attachment:${asset.fileName}`);
  }

  // PASS 2：按标记重写（在清洗前的 DOM 上做，清洗保留 data-* 属性）
  for (const img of [...doc.querySelectorAll(`img[${markAttr}]`)]) {
    const mark = img.getAttribute(markAttr)!;
    if (mark === 'missing') {
      const span = doc.createElement('span');
      span.className = 'en-media-missing';
      span.textContent = '⚠️ 资源缺失（HTML 导出中未找到引用文件）';
      img.replaceWith(span);
    } else {
      img.setAttribute('src', mark);
    }
    img.removeAttribute(markAttr);
  }
  for (const a of [...doc.querySelectorAll(`a[${markAttr}]`)]) {
    const mark = a.getAttribute(markAttr)!;
    if (mark.startsWith('attachment:')) {
      const span = doc.createElement('span');
      span.className = 'en-attachment-ref';
      span.textContent = `📎 附件：${mark.slice('attachment:'.length)}（见文末附件区）`;
      a.replaceWith(span);
    }
    a.removeAttribute(markAttr);
  }

  const body = doc.body;
  // 标题从当前 DOM 一次提取（PASS 1/2 仅处理 img/a，标题节点原样），
  // 与 extractTitleFromHtml 共用同一 <title>→h1 回退实现；
  // <title> 位于 <head>，本就不会进入 body.innerHTML，无需移除
  const { title: titleText, h1 } = extractTitleFromDocument(doc);
  if (h1 !== null && titleText.length > 0) {
    // 客户端导出可能把同一标题复制成多个 h1：与标题同文的 h1 全部移除，
    // 不重复进正文（文件名 <title> 与 h1 与正文头重复）
    for (const heading of [...doc.querySelectorAll('h1')]) {
      if ((heading.textContent ?? '').trim() === titleText) heading.remove();
    }
  }

  result.bodyHtml = sanitizeNoteHtml(body.innerHTML);
  return result;
}
