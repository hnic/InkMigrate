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
 * 精简模式：只保留 title 和 source_url，保持笔记干净。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const { item } = i;
  const props: Record<string, unknown> = {
    title: item.title,
  };
  if (item.ref.canonicalUrl !== undefined) {
    props.source_url = item.ref.canonicalUrl;
  }

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
