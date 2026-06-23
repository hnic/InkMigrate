import { stringify } from 'yaml';
import type { SourceItem } from '@inkmigrate/core';
import { buildInkmigrateId } from '@inkmigrate/core';

export interface FrontmatterInput {
  item: SourceItem;
  stableKey: string;
  migrationJobId: string;
  inkmigrateVersion: number;
  sourceContentHash: string;
  importedAt: string;
}

/**
 * §13.5 通用 YAML Properties 生成。
 *
 * 规则：
 * - 使用 yaml 库，不手工拼接。
 * - 属性扁平化，不嵌套。
 * - 每个属性名唯一。
 * - 日期 ISO 8601。
 * - 不知道的字段省略，不伪造时间。
 * - tags 和 source_collections 使用列表。
 * - inkmigrate_id 在目标 Vault 中唯一。
 * - source_content_hash 是核心标准化 SourceItem 正文哈希（调用方计算后传入）。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const { item, stableKey } = i;
  const ref = item.ref;
  const props: Record<string, unknown> = {
    title: item.title,
    inkmigrate_id: buildInkmigrateId(ref.sourceInstanceId, stableKey),
    inkmigrate_version: i.inkmigrateVersion,
    migration_job_id: i.migrationJobId,
    source: deriveSourceName(ref.sourceInstanceId),
    source_instance: ref.sourceInstanceId,
    source_type: ref.contentKind,
    imported_at: i.importedAt,
    source_content_hash: i.sourceContentHash,
  };
  if (ref.externalId !== undefined) {
    props.source_item_id = ref.externalId;
  }
  if (ref.canonicalUrl !== undefined) {
    props.source_url = ref.canonicalUrl;
  }
  // 集合去重
  const collections = dedupe(item.collections);
  if (collections.length > 0) {
    props.source_collections = collections;
  }
  if (item.author !== undefined) {
    props.author = item.author;
  }
  if (item.publishedAt !== undefined) {
    props.published_at = item.publishedAt;
  }
  if (item.favoritedAt !== undefined) {
    props.favorited_at = item.favoritedAt;
  }
  // 标签：合并 SourceItem.tags + 默认系统标签
  const tags = dedupe([
    ...item.tags,
    `source/${props.source}`,
    `type/${ref.contentKind}`,
    'status/imported',
  ]);
  props.tags = tags;

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}

function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/**
 * 从 sourceInstanceId 推导简短来源名（去掉实例后缀）。
 * 例：`toutiao-main` → `toutiao`；`evernote-personal` → `evernote`。
 * 如果没有 `-`，原样返回。
 */
function deriveSourceName(sourceInstanceId: string): string {
  const dashIdx = sourceInstanceId.indexOf('-');
  return dashIdx > 0 ? sourceInstanceId.slice(0, dashIdx) : sourceInstanceId;
}
