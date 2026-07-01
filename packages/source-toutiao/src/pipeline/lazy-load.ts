import { JSDOM } from 'jsdom';

/**
 * M4: 校验 URL 字符串的 scheme 是否安全（仅允许 http/https/协议相对/路径相对）。
 * stage 5 DOMPurify 对 srcset 做整值去空白 URI 白名单校验，非逐候选 URL，故
 * stage 6 提升首候选到 src 前需独立校验，杜绝 javascript:/data: 注入。
 */
function isSafeUrlScheme(url: string, baseUrl: string): boolean {
  try {
    const u = new URL(url, baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    // 解析失败视为不安全
    return false;
  }
}

/**
 * §12.9 stage 6：解析相对 URL、懒加载资源和附件引用。
 *
 * - 把相对 URL 转绝对（基于 baseUrl）。
 * - 识别 `data-src`、`data-original`、`srcset` 等懒加载属性，把首个候选提升到 `src`。
 * - 收集所有最终图片 URL，供调用方做附件下载清单。
 *
 * 不下载，只解析与规范化。
 */
export interface LazyLoadResult {
  html: string;
  /** 所有最终图片 URL（已转绝对）。 */
  images: string[];
  /** 被识别为懒加载、提升到 src 的图片 URL 子集。 */
  lazyLoadImages: string[];
}

export function resolveLazyLoadAndUrls(
  html: string,
  baseUrl: string,
): LazyLoadResult {
  const dom = new JSDOM(html, {
    url: baseUrl,
    // §12.9 stage 1：所有 jsdom 实例必须显式禁用脚本执行。
    runScripts: 'outside-only',
    resources: undefined,
  });
  const doc = dom.window.document;
  const images: string[] = [];
  const lazyLoadImages: string[] = [];

  // 图片：先解析懒加载
  doc.querySelectorAll('img').forEach((img) => {
    // §I-B：data-* 属性优先（高清原图），srcset 仅作兜底。
    // 此前顺序反了：srcset 先被解析，随后 data-src/data-original/data-lazy-src
    // 又覆盖了 src，导致低清 data-src 覆盖了高清 srcset。
    let resolved: string | null = null;
    for (const attr of ['data-original', 'data-src', 'data-lazy-src']) {
      const v = img.getAttribute(attr);
      if (v) {
        resolved = v;
        break;
      }
    }
    // 仅当无 data-* 时，回退到 srcset 第一个候选
    if (resolved === null) {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
        // M4: srcset 在 DOMPurify（stage 5）中按整值去空白做 URI 白名单校验，
        // 非逐候选 URL 校验，故此处提升首候选到 src 前需独立校验 scheme。
        // 拒绝 javascript:/data: 等危险 scheme（仅允许 http/https/协议相对/根相对）。
        if (first && isSafeUrlScheme(first, baseUrl)) {
          resolved = first;
        }
      }
    }
    if (resolved !== null) {
      img.setAttribute('src', resolved);
    }
    const src = img.getAttribute('src');
    if (src) {
      try {
        const abs = new URL(src, baseUrl).toString();
        // M4: 最终 src 也校验 scheme，防御 data-* 提升或 DOMPurify 残留的危险 scheme。
        if (!isSafeUrlScheme(abs, baseUrl)) return;
        img.setAttribute('src', abs);
        images.push(abs);
        if (
          img.hasAttribute('data-src') ||
          img.hasAttribute('data-original')
        ) {
          lazyLoadImages.push(abs);
        }
      } catch {
        // 无效 URL 跳过
      }
    }
  });

  // 锚点相对 URL 转绝对
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href) {
      try {
        const abs = new URL(href, baseUrl).toString();
        a.setAttribute('href', abs);
      } catch {
        // ignore
      }
    }
  });

  return {
    html: doc.body?.innerHTML ?? '',
    images,
    lazyLoadImages,
  };
}
