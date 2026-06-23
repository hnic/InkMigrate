import {
  computeFingerprint,
  computeStableKey,
  type SourceAdapter,
  type SourceContentKind,
  type SourceItemRef,
} from '@inkmigrate/core';
import { TOUTIAO_CAPABILITIES } from '../capabilities.js';
import { deriveFingerprintInput } from '../normalize/fingerprint.js';

export const SOURCE_TOUTIAO_KIND = 'toutiao' as const;
export const SOURCE_TOUTIAO_VERSION = '1.0.0' as const;
export const SOURCE_TOUTIAO_ADAPTER_API_VERSION = '1.0.0' as const;

/**
 * §12 + §8.2 今日头条来源适配器工厂。
 *
 * Stage 3 返回的对象在 scan/extract 中需要真实 Playwright 浏览器；本工厂
 * 返回的实例假设调用方在 ctx 中传入浏览器会话。fixture-driven 测试用
 * 一个包装对象覆盖 scan/extract（见 adapter.test.ts）。
 *
 * 真实浏览器版的 scan/extract 在 stage 4 Job 编排层接入时由本包的
 * browser-pool + auth-session + scanner + detail-extractor 组合实现。
 * stage 3 的契约是：capabilities 正确、scan/extract 的形状正确、
 * fixture 可驱动。
 */
export function createToutiaoSource(): SourceAdapter {
  return {
    kind: SOURCE_TOUTIAO_KIND,
    version: SOURCE_TOUTIAO_VERSION,
    adapterApiVersion: SOURCE_TOUTIAO_ADAPTER_API_VERSION,
    capabilities: TOUTIAO_CAPABILITIES,
    // §12.1 v1.1 supportsSourceCleanup=true → cleanup 必须存在（§8.2 不变量）
    cleanup: {
      supportedActions: ['unfavorite'],
      inspectActionState: async () => ({ state: 'unknown' }),
      executeAction: async () => ({ success: false, reason: 'requires real browser session' }),
      verifyAction: async () => ({ verified: false }),
    },
    validateConfig: async () => ({ ok: true }),
    prepare: async () => {
      // 真实实现：启动 Playwright、加载 Profile；stage 3 占位
    },
    scan: async function* (_ctx) {
      // 真实实现：scanFavoritesList + scrollForMore（用 Playwright）
      // stage 3 通过 fixture-driven 包装覆盖本方法做测试
      void _ctx;
    },
    extract: async (_ref, _ctx) => {
      // 真实实现：detail-extractor + pipeline
      // stage 3 通过 fixture-driven 包装覆盖本方法做测试
      throw new Error(
        'createToutiaoSource().extract requires a real browser session; use fixture-driven wrapper for tests',
      );
    },
    close: async () => {
      // 真实实现：关闭 Playwright
    },
  };
}

/** 内部工具：从 FavoriteItem 字段构造 SourceItemRef。供真实 scan 使用。 */
export function buildRefFromFavorite(
  sourceInstanceId: string,
  favorite: {
    externalId?: string;
    canonicalUrl: string;
    originalUrl: string;
    title: string;
    contentKind: SourceContentKind;
    publishedAt?: string;
    sourceMetadata: Record<string, unknown>;
  },
  discoveredAt: string,
): SourceItemRef {
  const fpInputBuilder: Parameters<typeof deriveFingerprintInput>[0] = {
    canonicalUrl: favorite.canonicalUrl,
    title: favorite.title,
    originalUrl: favorite.originalUrl,
  };
  if (favorite.externalId !== undefined) fpInputBuilder.contentId = favorite.externalId;
  if (favorite.publishedAt !== undefined) fpInputBuilder.publishedAt = favorite.publishedAt;
  const fpInput = deriveFingerprintInput(fpInputBuilder);
  const fingerprint = computeFingerprint(fpInput);
  const ref: SourceItemRef = {
    sourceInstanceId,
    canonicalUrl: favorite.canonicalUrl,
    originalUrl: favorite.originalUrl,
    title: favorite.title,
    contentKind: favorite.contentKind,
    discoveredAt,
    fingerprint,
    sourceMetadata: favorite.sourceMetadata,
  };
  if (favorite.externalId !== undefined) ref.externalId = favorite.externalId;
  return ref;
}

/** 内部工具：stable key（stage 4 写 target_artifacts 时用）。 */
export function stableKeyForRef(ref: SourceItemRef): string {
  return computeStableKey(ref.sourceInstanceId, ref.fingerprint);
}
