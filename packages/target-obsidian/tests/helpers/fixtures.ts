import type { SourceItem, SourceItemRef } from '@inkmigrate/core';

/** 共享样例值：makeRef 与 makeFullArticleItem 保持同一份基础数据，
 * 避免 ref.externalId 与 sourceMetadata.source_item_id 各自漂移失配。 */
const SAMPLE_TITLE = '人工智能如何改变软件开发';
const SAMPLE_EXTERNAL_ID = '7428193012345678901';

/**
 * §8.5 SourceItem 的可选字段在 `exactOptionalPropertyTypes` 下不接受 `undefined`
 * 显式赋值。用 `OptionalOverride` 让 fixture 调用方可以"删除" bodyHtml/bodyText
 * 两个可选字段（通过传 `omitBody: true`，仅支持这两个字段），或直接覆盖为同类型
 * 值；显式传入的 body 覆盖优先于 omitBody（不会被删除动作悄悄丢掉）。
 */
type OptionalOverride<T> = Partial<Omit<T, 'bodyHtml' | 'bodyText'>> & {
  bodyHtml?: string;
  bodyText?: string;
  /** 显式删除 bodyHtml/bodyText（让 degraded fixture 干净）。 */
  omitBody?: true;
};

/** 构造一个最小可用的 SourceItemRef（fingerprint 是占位，调用方按需覆盖）。 */
export function makeRef(overrides: Partial<SourceItemRef> = {}): SourceItemRef {
  return {
    sourceInstanceId: 'toutiao-main',
    externalId: SAMPLE_EXTERNAL_ID,
    canonicalUrl: 'https://www.toutiao.com/article/7428193012345678901/',
    title: SAMPLE_TITLE,
    contentKind: 'article',
    discoveredAt: '2026-06-22T14:30:00+08:00',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    sourceMetadata: {},
    ...overrides,
  };
}

/** 构造一个完整、quality=full 的 SourceItem（用于 plan/write 测试）。 */
export function makeFullArticleItem(
  overrides: OptionalOverride<SourceItem> = {},
): SourceItem {
  const base: SourceItem = {
    ref: makeRef(),
    title: SAMPLE_TITLE,
    author: '示例作者',
    publishedAt: '2025-12-20T10:35:00+08:00',
    favoritedAt: '2026-01-04T21:13:00+08:00',
    bodyHtml: '<p>正文第一段。</p><p>正文第二段。</p>',
    summary: '一段摘要',
    tags: ['#技术'],
    collections: ['技术收藏'],
    assets: [],
    links: [],
    quality: 'full',
    degradations: [],
    extractionMethod: 'readability',
    extractionWarnings: [],
    sourceMetadata: { source_item_id: SAMPLE_EXTERNAL_ID },
  };
  return applyOverrides(base, overrides);
}

/** 构造一个 degraded 条目（无正文，只有元数据）。 */
export function makeDegradedItem(
  overrides: OptionalOverride<SourceItem> = {},
): SourceItem {
  return makeFullArticleItem({
    quality: 'degraded',
    degradations: [
      {
        code: 'body-missing',
        stage: 'extract',
        message: 'page returned empty body',
      },
    ],
    omitBody: true,
    ...overrides,
  });
}

/** 把 overrides 合并到 base；`omitBody` 会从结果中删除可选 body 字段——
 * 除非调用方显式提供了 body 覆盖（makeDegradedItem 固定携带 omitBody:true，
 * 删除动作不能把调用方补的正文悄悄丢掉，否则测试会在无感知中断言错场景）。 */
function applyOverrides(
  base: SourceItem,
  overrides: OptionalOverride<SourceItem>,
): SourceItem {
  const { omitBody, bodyHtml, bodyText, ...rest } = overrides;
  const merged: SourceItem = { ...base, ...rest };
  const hasExplicitBody = bodyHtml !== undefined || bodyText !== undefined;
  if (bodyHtml !== undefined) {
    merged.bodyHtml = bodyHtml;
  }
  if (bodyText !== undefined) {
    merged.bodyText = bodyText;
  }
  if (omitBody && !hasExplicitBody) {
    delete merged.bodyHtml;
    delete merged.bodyText;
  }
  return merged;
}

