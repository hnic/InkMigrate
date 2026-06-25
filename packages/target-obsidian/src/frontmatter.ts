import { stringify } from 'yaml';
import type { SourceItem } from '@inkmigrate/core';

export interface FrontmatterInput {
  item: SourceItem;
  // 以下字段为兼容性保留（精简模式不使用，但 adapter 调用时传入）
  stableKey: string;
  migrationJobId: string;
  inkmigrateVersion: number;
  sourceContentHash: string;
  importedAt: string;
}

/**
 * §13.5 通用 YAML Properties 生成。
 *
 * 精简模式：只保留 title 和 source_url，保持笔记干净。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const props: Record<string, unknown> = {
    title: i.item.title,
  };
  if (i.item.ref.canonicalUrl !== undefined) {
    props.source_url = i.item.ref.canonicalUrl;
  }

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}
