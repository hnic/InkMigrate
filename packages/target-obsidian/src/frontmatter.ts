import { stringify } from 'yaml';
import type { SourceItem } from '@inkmigrate/core';

export interface FrontmatterInput {
  item: SourceItem;
  stableKey: string;
  sourceContentHash: string;
}

/**
 * 运行时 null（如 JSON 往返/宽松提取器）与 undefined 一律视为缺失：
 * `!== undefined` 会让 null 通过并在 YAML 中写出 `author: null`，
 * 改变输出字节（影响 targetContentHash 漂移检测）并产生无效 Obsidian 属性。
 */
const present = (v: string | null | undefined): v is string =>
  v !== undefined && v !== null;

/**
 * §13.5 通用 YAML Properties 生成。
 *
 * M8: 在精简模式基础上补入稳定溯源字段（source_content_hash / inkmigrate_id），
 * 使笔记文件自带可审计来源，verifyNote 可靠重读 frontmatter 做内容漂移检测。
 * 这些字段均为稳定值（不随重渲染/resume 变化），不影响 targetContentHash 的幂等性。
 *
 * ⚠️ 不得写入会变化的字段（importedAt 随 plan 时间变化、migration_job_id 在 resume
 * 时变化），否则 renderedContent 变化 → targetContentHash 变化 → 幂等性检测失效，
 * 重跑/resume 会误判为「内容已变」而重复写入。migration_job_id 的溯源由 DB 侧的
 * migration_attempts 承担，无需进文件。因此 FrontmatterInput 也不接受这些字段。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const props: Record<string, unknown> = {
    title: i.item.title,
  };
  if (present(i.item.ref.canonicalUrl)) {
    props.source_url = i.item.ref.canonicalUrl;
  }
  // M8: 仅写入稳定溯源字段（值跨 resume 不变，不破坏 targetContentHash 幂等性）。
  // 以下条件字段（§15.8/§15.9）同为提取期确定值，幂等性不受影响；
  // 缺失即不写——头条等未携带的字段对其输出零影响。
  if (i.item.tags.length > 0) {
    // Obsidian 属性标签不允许空格、# 等字符；写入前做最小归一化
    // （去前导 #，剔除空值与含空白的标签），保证生成的 Properties 始终有效。
    const safeTags = i.item.tags
      .map((t) => t.trim().replace(/^#/, ''))
      .filter((t) => t.length > 0 && !/\s/.test(t));
    if (safeTags.length > 0) {
      props.tags = safeTags;
    }
  }
  if (present(i.item.author)) {
    props.author = i.item.author;
  }
  if (present(i.item.createdAt)) {
    props.created_at = i.item.createdAt;
  }
  if (present(i.item.updatedAt)) {
    props.updated_at = i.item.updatedAt;
  }
  // sourceMetadata 是 unknown 袋子：仅接受字符串值，非字符串（数字/嵌套对象/
  // 数组）一律视为缺失，避免把任意值原样写进 YAML——嵌套值会序列化为多行
  // 结构，改变输出字节并产生无效 Obsidian 属性。
  const sm = i.item.sourceMetadata as Partial<
    Record<
      | 'notebook'
      | 'stack'
      | 'source_url'
      | 'source_type'
      | 'latitude'
      | 'longitude'
      | 'altitude'
      | 'place_name',
      unknown
    >
  >;
  if (typeof sm?.notebook === 'string') {
    props.source_notebook = sm.notebook;
  }
  if (typeof sm?.stack === 'string') {
    props.source_stack = sm.stack;
  }
  if (props.source_url === undefined && typeof sm?.source_url === 'string') {
    props.source_url = sm.source_url;
  }
  if (typeof sm?.source_type === 'string') {
    props.source_type = sm.source_type;
  }
  // §15.8 地理位置（来源显式启用才会出现）
  if (typeof sm?.latitude === 'string') {
    props.source_latitude = sm.latitude;
  }
  if (typeof sm?.longitude === 'string') {
    props.source_longitude = sm.longitude;
  }
  if (typeof sm?.altitude === 'string') {
    props.source_altitude = sm.altitude;
  }
  if (typeof sm?.place_name === 'string') {
    props.source_place_name = sm.place_name;
  }
  props.source_content_hash = i.sourceContentHash;
  props.inkmigrate_id = i.stableKey;

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}
