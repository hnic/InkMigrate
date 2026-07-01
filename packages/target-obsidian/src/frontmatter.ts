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
 * M8: 在精简模式基础上补入稳定溯源字段（source_content_hash / inkmigrate_id），
 * 使笔记文件自带可审计来源，verifyNote 可靠重读 frontmatter 做内容漂移检测。
 * 这些字段均为稳定值（不随重渲染/resume 变化），不影响 targetContentHash 的幂等性。
 *
 * ⚠️ 不得写入会变化的字段（importedAt 随 plan 时间变化、migration_job_id 在 resume
 * 时变化），否则 renderedContent 变化 → targetContentHash 变化 → 幂等性检测失效，
 * 重跑/resume 会误判为「内容已变」而重复写入。migration_job_id 的溯源由 DB 侧的
 * migration_attempts 承担，无需进文件。
 */
export function stringifyFrontmatter(i: FrontmatterInput): string {
  const props: Record<string, unknown> = {
    title: i.item.title,
  };
  if (i.item.ref.canonicalUrl !== undefined) {
    props.source_url = i.item.ref.canonicalUrl;
  }
  // M8: 仅写入稳定溯源字段（值跨 resume 不变，不破坏 targetContentHash 幂等性）
  props.source_content_hash = i.sourceContentHash;
  props.inkmigrate_id = i.stableKey;

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}
