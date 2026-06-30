import type { SourceContentKind } from '@inkmigrate/core';

export interface DetectInput {
  url?: string;
  /** 来源适配器从 DOM/网络响应得到的显式类型提示。 */
  hint?: string;
  /** 其它结构信号（如图集图片数）。 */
  [k: string]: unknown;
}

/**
 * §12.7 内容类型判定。优先级：
 * 1. 显式 hint（适配器从 DOM/网络响应识别）。
 * 2. URL 路径推断。
 * 3. unknown 兜底。
 */
export function detectContentKind(input: DetectInput): SourceContentKind {
  // 1. hint
  if (input.hint !== undefined) {
    const mapped = mapHint(input.hint);
    if (mapped !== undefined) return mapped;
  }
  // 2. URL 路径
  if (input.url !== undefined) {
    try {
      const u = new URL(input.url);
      // §I-D：新增 /a/、/group/ 文章路径（旧路径检测会把这些判成 'unknown'）。
      // /w/ 改为锚定后续数字（/\/w\/(\d+)/），避免误命中 /world/ 等路径。
      if (/\/(article|a|group)\//.test(u.pathname)) return 'article';
      if (/\/wenda\//.test(u.pathname)) return 'question-answer';
      if (/\/video\//.test(u.pathname)) return 'video';
      if (/\/w\/(\d+)/.test(u.pathname)) return 'short-post'; // 微头条
    } catch {
      // ignore
    }
  }
  return 'unknown';
}

function mapHint(hint: string): SourceContentKind | undefined {
  const h = hint.toLowerCase().trim();
  if (['article', '文章', '普通文章'].includes(h)) return 'article';
  if (['short-post', '微头条', '短文本'].includes(h)) return 'short-post';
  if (['gallery', '图集'].includes(h)) return 'gallery';
  if (['question-answer', '问答', 'wenda'].includes(h)) return 'question-answer';
  if (['video', '视频'].includes(h)) return 'video';
  if (['note', '笔记'].includes(h)) return 'note';
  if (['external-link', '外部链接'].includes(h)) return 'external-link';
  return undefined;
}
