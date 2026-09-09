import type { SourceContentKind } from '@inkmigrate/core';

/** 相对路径兜底基址：detectContentKind 是公共 API，需兼容裸 anchor href。 */
const TOUTIAO_ORIGIN = 'https://www.toutiao.com';

export interface DetectInput {
  url?: string;
  /** 来源适配器从 DOM/网络响应得到的显式类型提示。 */
  hint?: string;
  /**
   * 其它结构信号（如图集图片数）的预留扩展位：当前 detectContentKind 尚未
   * 读取任何额外信号（仅 url/hint 参与判定），图集等依赖结构信号的类型
   * 需显式 hint 才能识别，请勿依赖此索引签名产生判定。
   */
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
      // 传基址兼容相对路径（DOM anchor 的裸 href），解析失败仍落入 unknown 兜底
      const u = new URL(input.url, TOUTIAO_ORIGIN);
      // URL 解析只小写 scheme/host，路径保持原样；抓取到的 /Article/ 等大写
      // 路径若不归一化会漏判，先统一小写再匹配
      const path = u.pathname.toLowerCase();
      // §I-D：新增 /a/、/group/ 文章路径（旧路径检测会把这些判成 'unknown'）。
      // /w/ 改为锚定后续数字（/\/w\/\d+/），避免误命中 /world/ 等路径。
      if (/\/(article|a|group)\//.test(path)) return 'article';
      if (/\/wenda\//.test(path)) return 'question-answer';
      if (/\/video\//.test(path)) return 'video';
      if (/\/w\/\d+/.test(path)) return 'short-post'; // 微头条
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
