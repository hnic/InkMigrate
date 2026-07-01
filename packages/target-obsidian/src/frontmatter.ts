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
 * M8: 在精简模式基础上补入稳定溯源字段（source_content_hash / inkmigrate_id /
 * migration_job_id），使笔记文件自带可审计来源，verifyNote 可靠重读 frontmatter
 * 做内容漂移检测。这些字段均为稳定值（不随重渲染变化），不影响 targetContentHash
 * 的幂等性。importedAt 不写入（其随 plan 时间变化，会破坏 hash 稳定性）。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const props: Record<string, unknown> = {
    title: i.item.title,
  };
  if (i.item.ref.canonicalUrl !== undefined) {
    props.source_url = i.item.ref.canonicalUrl;
  }
  // M8: 稳定溯源字段（值不变，安全进 frontmatter 不破坏 hash 幂等性）
  props.source_content_hash = i.sourceContentHash;
  props.inkmigrate_id = i.stableKey;
  if (i.migrationJobId !== 'unknown') {
    props.migration_job_id = i.migrationJobId;
  }

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}
