import type { SourceItem, SourceItemRef } from '@inkmigrate/core';

/**
 * §8.5 SourceItem 的可选字段在 `exactOptionalPropertyTypes` 下不接受 `undefined`
 * 显式赋值。用 `OptionalOverride` 让 fixture 调用方可以"删除"一个可选字段
 * （通过传 `__omit` 标记），或直接覆盖为同类型值。
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
    externalId: '7428193012345678901',
    canonicalUrl: 'https://www.toutiao.com/article/7428193012345678901/',
    title: '人工智能如何改变软件开发',
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
    title: '人工智能如何改变软件开发',
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
    sourceMetadata: { source_item_id: '7428193012345678901' },
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

/** 把 overrides 合并到 base；`omitBody` 会从结果中删除可选 body 字段。 */
function applyOverrides(
  base: SourceItem,
  overrides: OptionalOverride<SourceItem>,
): SourceItem {
  const { omitBody, bodyHtml, bodyText, ...rest } = overrides;
  const merged: SourceItem = { ...base, ...rest };
  if (bodyHtml !== undefined) {
    merged.bodyHtml = bodyHtml;
  }
  if (bodyText !== undefined) {
    merged.bodyText = bodyText;
  }
  if (omitBody) {
    delete merged.bodyHtml;
    delete merged.bodyText;
  }
  return merged;
}

