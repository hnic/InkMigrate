import { JSDOM } from 'jsdom';

/**
 * §12.9 stage 3：预清洗。在 Readability/提取前移除明显危险内容：
 * - `<script>`、`<style>`、`<iframe>`、`<object>`、`<embed>`、`<noscript>`
 * - `<base>`（重写全部相对 URL 的解析基址）、`<meta http-equiv="refresh">`
 *   （content 属性可携带 javascript:/重定向目标，[src]/[href] 清洗覆盖不到）
 * - 所有 `on*` 事件属性
 * - `javascript:`、`vbscript:`、`file:`、`data:` URI（含 src/href 之外的
 *   经典 URI 汇聚点：xlink:href、action/formaction、poster、background、srcset）
 *
 * 不激进删除正文结构（§12.9 要求）。
 *
 * 异常契约：本函数对畸形输入抛出的异常由 runSafetyPipeline 的 stage 3
 * try/catch 捕获并按 'unsupported-structure' 降级——不在函数内吞错返回空串，
 * 那会把解析失败误标成 body-missing。
 */
export function preCleanHtml(html: string): string {
  // §12.9 stage 1：jsdom 默认配置即完全禁用脚本执行与远程资源加载。
  // 注：'outside-only' 仍会开放 window.eval（多余的攻击面），resources: undefined
  // 是无效默认值；真正的加固是省略这两个选项（与 sanitize/lazy-load 同口径）。
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  removeElements(doc, ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'base']);
  // meta refresh 的 http-equiv 值大小写不敏感，逐个检查而非依赖选择器的 i 旗标
  //（避免选择器引擎差异导致漏删/抛错）
  doc.querySelectorAll('meta[http-equiv]').forEach((el) => {
    if (el.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') {
      el.remove();
    }
  });
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

/** 承载 URI 的属性全集：不只 src/href——xlink:href（SVG）、action/formaction
 *（表单）、poster、background、srcset、object data 都是已知的清洗旁路面。 */
const URI_ATTRS = [
  'src', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'srcset', 'data',
] as const;

function stripDangerousUris(doc: Document): void {
  // data: 可携带活动内容（data:text/html,<script>…），与 js:/vb:/file: 一并阻断；
  // 需要内联图片（data:image/*）时应在实现处显式放行，而非默认全放
  const dangerous = /^(?:javascript|vbscript|file|data):/i;
  // 浏览器解析 URL scheme 时会忽略其中内嵌的控制字符/空白
  //（如 "java\tscript:alert(1)"），故先归一化（剔除 C0 控制符+空格）再匹配，
  // 否则 trim 只去首尾空白，内嵌混淆可绕过前缀检测
  const normalize = (v: string): string => v.replace(/[\u0000-\u0020]/g, '');
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of URI_ATTRS) {
      const v = el.getAttribute(attr);
      if (v !== null && dangerous.test(normalize(v))) {
        el.removeAttribute(attr);
      }
    }
  });
}
