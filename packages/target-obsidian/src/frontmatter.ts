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
  // M8: 仅写入稳定溯源字段（值跨 resume 不变，不破坏 targetContentHash 幂等性）。
  // 以下条件字段（§15.8/§15.9）同为提取期确定值，幂等性不受影响；
  // 缺失即不写——头条等未携带的字段对其输出零影响。
  if (i.item.tags.length > 0) {
    props.tags = i.item.tags;
  }
  if (i.item.author !== undefined) {
    props.author = i.item.author;
  }
  if (i.item.createdAt !== undefined) {
    props.created_at = i.item.createdAt;
  }
  if (i.item.updatedAt !== undefined) {
    props.updated_at = i.item.updatedAt;
  }
  const sm = i.item.sourceMetadata as {
    notebook?: string;
    stack?: string;
    source_url?: string;
    source_type?: string;
  };
  if (sm?.notebook !== undefined) {
    props.source_notebook = sm.notebook;
  }
  if (sm?.stack !== undefined) {
    props.source_stack = sm.stack;
  }
  if (props.source_url === undefined && sm?.source_url !== undefined) {
    props.source_url = sm.source_url;
  }
  if (sm?.source_type !== undefined) {
    props.source_type = sm.source_type;
  }
  props.source_content_hash = i.sourceContentHash;
  props.inkmigrate_id = i.stableKey;

  const body = stringify(props, { lineWidth: 0 });
  return `---\n${body}---\n`;
}
