import { JSDOM } from 'jsdom';

/**
 * §12.9 stage 3：预清洗。在 Readability/提取前移除明显危险内容：
 * - `<script>`、`<style>`、`<iframe>`、`<object>`、`<embed>`、`<noscript>`
 * - 所有 `on*` 事件属性
 * - `javascript:`、`vbscript:`、`file:` URI
 *
 * 不激进删除正文结构（§12.9 要求）。
 */
export function preCleanHtml(html: string): string {
  const dom = new JSDOM(html, {
    // §12.9 stage 1：jsdom 创建时禁止脚本执行和远程资源自动加载
    runScripts: 'outside-only',
    resources: undefined,
  });
  const doc = dom.window.document;

  removeElements(doc, ['script', 'style', 'iframe', 'object', 'embed', 'noscript']);
  stripEventHandlers(doc);
  stripDangerousUris(doc);

  return doc.body?.innerHTML ?? '';
}

function removeElements(doc: Document, tags: string[]): void {
  for (const tag of tags) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }
}

function stripEventHandlers(doc: Document): void {
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
  });
}

function stripDangerousUris(doc: Document): void {
  const dangerous = /^(javascript|vbscript|file):/i;
  doc.querySelectorAll<HTMLElement>('[src], [href]').forEach((el) => {
    for (const attr of ['src', 'href'] as const) {
      const v = el.getAttribute(attr);
      if (v !== null && dangerous.test(v.trim())) {
        el.removeAttribute(attr);
      }
    }
  });
}
