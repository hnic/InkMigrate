import { JSDOM } from 'jsdom';

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
    // srcset 第一个候选
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (first) {
        img.setAttribute('src', first);
      }
    }
    // data-src / data-original
    for (const attr of ['data-src', 'data-original', 'data-lazy-src']) {
      const v = img.getAttribute(attr);
      if (v) {
        img.setAttribute('src', v);
        break;
      }
    }
    const src = img.getAttribute('src');
    if (src) {
      try {
        const abs = new URL(src, baseUrl).toString();
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
