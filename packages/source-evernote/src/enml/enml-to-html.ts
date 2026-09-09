import { JSDOM } from 'jsdom';
import createDompurify from 'dompurify';
import type { SourceAsset } from '@inkmigrate/core';
import { enexResourceUri } from '../resources/process-resources.js';

/**
 * §15.6 ENML → 清洗后 HTML。
 *
 * 流程：DOMPurify 允许列表清洗（en-* 标签显式加入；evernote: 链接 scheme 显式
 * 放行）→ DOM 转换（en-todo/en-media/en-crypt/远程 img）→ 序列化。
 * 转换阶段只创建已知安全节点：enex-resource URI 的 hash 段强制为 32 位 hex，
 * 占位文本经 textNode 写入，无注入面。
 *
 * 图片资源以 `<img src="enex-resource://<md5>">` 输出，与 SourceAsset.originalUrl
 * 同值——目标端按 URL 匹配本地化（与头条图片同一机制）。
 */

const dom = new JSDOM('', { runScripts: 'outside-only' });
const DOMPurify = createDompurify(dom.window as never);

const SANITIZE_CONFIG = {
  ADD_TAGS: [
    'en-note', 'en-todo', 'en-media', 'en-crypt',
    'input', 'font', 'center', 'u', 's', 'strike', 'tt', 'big', 'small',
  ],
  ADD_ATTR: [
    'hash', 'checked', 'hint', 'cipher', 'length',
    'type', 'disabled', 'alt', 'src', 'href',
    'style', 'align', 'border', 'hspace', 'vspace', 'longdesc', 'usemap',
    'bgcolor', 'text', 'width', 'height', 'lang', 'dir', 'charset', 'target',
    'colspan', 'rowspan', 'cite', 'datetime', 'start', 'value', 'title',
  ],
  // §15.10：保留 evernote:// 内部链接（默认白名单会剥掉该 scheme）
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|evernote|evernote-resource|enex-resource):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

export interface ResourceRefInfo {
  kind: SourceAsset['kind'];
  fileName: string;
  attachment: boolean;
}

export interface EnmlTransformResult {
  html: string;
  /** 正文中的远程 <img>（http/https，网页剪藏常见；非 resource）。 */
  remoteImages: Array<{ url: string; alt?: string | undefined }>;
  /** evernote:// 内部链接（ENEX 无 GUID 映射，保留原链接并记录，§15.10）。 */
  internalLinks: Array<{ url: string; text: string }>;
  externalLinks: Array<{ url: string; text: string }>;
  /** §15.11 加密块占位记录。 */
  cryptBlocks: Array<{ hint?: string | undefined; cipher?: string | undefined; length?: string | undefined }>;
  /** 正文引用但找不到匹配资源的 en-media hash（§15.7.5 资源缺失）。 */
  missingMediaHashes: string[];
  todoCount: number;
}

const MD5_HEX = /^[0-9a-f]{32}$/i;

/**
 * §15.12 共享的正文清洗（HTML 导出解析复用）：DOMPurify 允许列表 +
 * evernote: scheme 放行 + data-* 保留（资源重写标记依赖）。
 */
export function sanitizeNoteHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/** §15.6 ENML → 清洗后 HTML。resourceByMd5 为空 Map 时全部 en-media 视为缺失。 */
export function enmlToHtml(
  enml: string,
  resourceByMd5: ReadonlyMap<string, ResourceRefInfo>,
): EnmlTransformResult {
  const result: EnmlTransformResult = {
    html: '',
    remoteImages: [],
    internalLinks: [],
    externalLinks: [],
    cryptBlocks: [],
    missingMediaHashes: [],
    todoCount: 0,
  };
  const input = enml.trim();
  if (input.length === 0) return result;

  // 剥离 ENML 自带的 DOCTYPE（DOMParser text/html 不接受且无意义）
  const stripped = input.replace(/^<!DOCTYPE[^>]*>\s*/i, '');
  // ENML 是 XHTML：自闭合标签（<en-media/> 等）在 text/html 解析中不闭合，
  // 会把后续兄弟节点吞成子节点——替换 en-media 时连带丢失正文。显式闭合化。
  const balanced = stripped.replace(
    /<(en-media|en-todo|en-crypt)\b([^>]*?)\/>/gi,
    (_m, tag: string, attrs: string) => `<${tag}${attrs}></${tag}>`,
  );
  const clean = DOMPurify.sanitize(balanced, SANITIZE_CONFIG);

  const parser = new dom.window.DOMParser();
  const doc = parser.parseFromString(clean, 'text/html');
  const body = doc.body;

  // 1. en-note 解包（子元素上移，序列化不含包裹层）
  for (const root of [...body.querySelectorAll('en-note')]) {
    const parent = root.parentElement;
    if (parent === null) continue;
    while (root.firstChild !== null) parent.insertBefore(root.firstChild, root);
    parent.removeChild(root);
  }

  // 2. en-crypt → 占位块（§15.11：保留 hint/cipher/length 元数据，不破解）
  for (const cryptEl of [...body.querySelectorAll('en-crypt')]) {
    const hint = cryptEl.getAttribute('hint') ?? undefined;
    const cipher = cryptEl.getAttribute('cipher') ?? undefined;
    const length = cryptEl.getAttribute('length') ?? undefined;
    result.cryptBlocks.push({ hint, cipher, length });
    const div = doc.createElement('div');
    div.className = 'en-crypt-placeholder';
    if (hint !== undefined) div.setAttribute('data-hint', hint);
    if (cipher !== undefined) div.setAttribute('data-cipher', cipher);
    if (length !== undefined) div.setAttribute('data-length', length);
    div.textContent = `🔒 加密内容未迁移（cipher=${cipher ?? '未知'}${hint !== undefined ? `，提示：${hint}` : ''}）`;
    cryptEl.replaceWith(div);
  }

  // 3. en-media → 内联图片 / 附件引用占位 / 缺失占位（§15.7.5）
  for (const mediaEl of [...body.querySelectorAll('en-media')]) {
    const hash = (mediaEl.getAttribute('hash') ?? '').trim().toLowerCase();
    const alt = mediaEl.getAttribute('alt') ?? undefined;
    const info = MD5_HEX.test(hash) ? resourceByMd5.get(hash) : undefined;
    if (info === undefined) {
      result.missingMediaHashes.push(hash.length > 0 ? hash : '(no-hash)');
      const span = doc.createElement('span');
      span.className = 'en-media-missing';
      span.textContent = `⚠️ 资源缺失（hash=${hash.slice(0, 8) || '无'}）`;
      mediaEl.replaceWith(span);
      continue;
    }
    if (info.kind === 'image' && !info.attachment) {
      const img = doc.createElement('img');
      img.setAttribute('src', enexResourceUri(hash));
      img.setAttribute('alt', alt && alt.length > 0 ? alt : info.fileName);
      mediaEl.replaceWith(img);
    } else {
      const span = doc.createElement('span');
      span.className = 'en-attachment-ref';
      span.textContent = `📎 附件：${info.fileName}（见文末附件区）`;
      mediaEl.replaceWith(span);
    }
  }

  // 4. en-todo → checkbox（div/p/span 包裹转 li + ul，turndown GFM 任务列表可转换）
  const convertedParents: Element[] = [];
  for (const todoEl of [...body.querySelectorAll('en-todo')]) {
    result.todoCount += 1;
    const input = doc.createElement('input');
    input.setAttribute('type', 'checkbox');
    input.setAttribute('disabled', '');
    if (todoEl.getAttribute('checked') === 'true') input.setAttribute('checked', '');
    todoEl.replaceWith(input);
    const parent = input.parentElement;
    if (parent !== null && ['div', 'p', 'span'].includes(parent.tagName.toLowerCase())) {
      convertedParents.push(parent);
    }
  }
  for (const el of convertedParents) {
    const li = doc.createElement('li');
    while (el.firstChild !== null) li.appendChild(el.firstChild);
    el.replaceWith(li);
  }
  // 连续转换出的 li 归组到 ul（保持文档顺序；原生列表 li 跳过）
  for (const li of [...body.querySelectorAll('li')]) {
    if (!li.querySelector('input[type="checkbox"]')) continue;
    const parent = li.parentElement;
    if (parent === null) continue;
    if (parent.tagName === 'UL' || parent.tagName === 'OL') continue;
    const prev = li.previousElementSibling;
    if (prev !== null && prev.tagName === 'UL' && prev.getAttribute('data-en-todo-list') === 'true') {
      prev.appendChild(li);
    } else {
      const ul = doc.createElement('ul');
      ul.setAttribute('data-en-todo-list', 'true');
      parent.insertBefore(ul, li);
      ul.appendChild(li);
    }
  }

  // 5. 链接与远程图片收集
  for (const a of [...body.querySelectorAll('a')]) {
    const href = a.getAttribute('href');
    if (href === null) continue;
    const text = (a.textContent ?? '').trim();
    if (href.startsWith('evernote://')) {
      result.internalLinks.push({ url: href, text });
    } else if (/^https?:\/\//i.test(href)) {
      result.externalLinks.push({ url: href, text });
    }
  }
  for (const img of [...body.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    if (src !== null && /^https?:\/\//i.test(src)) {
      result.remoteImages.push({ url: src, alt: img.getAttribute('alt') ?? undefined });
    }
  }

  result.html = body.innerHTML;
  return result;
}
