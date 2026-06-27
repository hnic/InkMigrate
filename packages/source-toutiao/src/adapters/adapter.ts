import {
  computeFingerprint,
  computeStableKey,
  type SourceAdapter,
  type SourceContentKind,
  type SourceItemRef,
  type SourceRefState,
  type CleanupActionState,
  type CleanupActionReceipt,
  type CleanupVerification,
} from '@inkmigrate/core';
import { TOUTIAO_CAPABILITIES } from '../capabilities.js';
import { deriveFingerprintInput } from '../normalize/fingerprint.js';
import { ToutiaoBrowserSession } from '../browser/browser-session.js';
import { driveScanFavorites } from '../browser/scan-driver.js';
import { driveExtractDetail } from '../browser/extract-driver.js';
import { driveUnfavorite, inspectCollectedState } from '../browser/unfavorite-driver.js';
import { SPECIAL_PAGE_SELECTORS, UNFAVORITE_SELECTORS } from '../selectors/index.js';

export const SOURCE_TOUTIAO_KIND = 'toutiao' as const;
export const SOURCE_TOUTIAO_VERSION = '1.0.0' as const;
export const SOURCE_TOUTIAO_ADAPTER_API_VERSION = '1.0.0' as const;

/** 默认收藏列表 URL。真实 URL 由配置或 CLI 提供。 */
const DEFAULT_FAVORITES_URL = 'https://www.toutiao.com/favorites';
const DEFAULT_BASE_URL = 'https://www.toutiao.com/';

/**
 * 浏览器适配器配置。传入 createToutiaoSource 时启用真实浏览器模式；
 * 不传时返回桩适配器（fixture-driven 测试用）。
 */
export interface ToutiaoBrowserAdapterConfig {
  sourceInstanceId: string;
  profileDir: string;
  headless?: boolean;
  favoritesUrl?: string;
  scanMaxEmptyCycles?: number;
  scanWaitAfterScrollMs?: number;
  navigationTimeoutMs?: number;
  maxImageBytes?: number;
  /** 限制扫描条目数（用于测试）；不传则扫描全部。 */
  maxScanItems?: number;
}

/**
 * §12 + §8.2 今日头条来源适配器工厂（双模式）。
 *
 * - 无参数：返回桩适配器。scan 产生空序列，extract 抛异常。
 *   fixture-driven 测试通过包装对象覆盖 scan/extract（见 adapter.test.ts）。
 *
 * - 有参数：返回真实浏览器适配器。
 *   prepare() 启动 Playwright 持久化上下文；
 *   scan() 用 driveScanFavorites 滚动收藏列表；
 *   extract() 用 driveExtractDetail 导航详情页；
 *   close() 关闭浏览器。
 *
 * 浏览器生命周期由适配器自身管理（adapter-owned），不通过 AdapterContext 传递。
 * 这符合 §8.2 prepare/scan/extract/close 生命周期契约。
 */
export function createToutiaoSource(
  browserConfig?: ToutiaoBrowserAdapterConfig,
): SourceAdapter {
  const session = browserConfig
    ? new ToutiaoBrowserSession({
        profileDir: browserConfig.profileDir,
        headless: browserConfig.headless ?? false,
      })
    : undefined;
  // 防止 OOM：每处理 100 条重启浏览器上下文
  let extractCount = 0;
  const RECYCLE_THRESHOLD = 100;

  return {
    kind: SOURCE_TOUTIAO_KIND,
    version: SOURCE_TOUTIAO_VERSION,
    adapterApiVersion: SOURCE_TOUTIAO_ADAPTER_API_VERSION,
    capabilities: TOUTIAO_CAPABILITIES,
    // §12.1 v1.1 supportsSourceCleanup=true → cleanup 必须存在（§8.2 不变量）
    cleanup: {
      supportedActions: ['unfavorite'],
      // inspect / execute / verify 三者通过 driveUnfavorite 的共享判定逻辑（aria-pressed
      // 主信号 + collected class 回退）保持状态读法一致；历史上 inspect/verify 用
      // collected class、execute 用 aria-pressed 的不一致已消除。
      inspectActionState: async (ref) => {
        if (session === undefined) return { state: 'unknown' as const };
        const page = await session.newPage();
        try {
          const url = ref.canonicalUrl;
          if (url === undefined) return { state: 'unknown' as const };
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const collectBtn = page
            .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
            .first();
          // 等待渲染：domcontentloaded 时 SPA 详情页可能尚未渲染按钮（旧逻辑瞬时
          // count()=0 → 误判 unknown，是生产"未知"大量产生的根因）
          try {
            await collectBtn.waitFor({ state: 'attached', timeout: 10_000 });
          } catch {
            // 超时则保留 not found → unknown 语义
          }
          const collected = await inspectCollectedState(collectBtn);
          if (collected === null) return { state: 'unknown' as const };
          return { state: collected ? 'favorited' as const : 'not-favorited' as const };
        } finally {
          await page.close();
        }
      },
      executeAction: async (ref, _action) => {
        if (session === undefined || browserConfig === undefined) {
          return { success: false, reason: 'requires real browser session' };
        }
        const page = await session.newPage();
        try {
          // driveUnfavorite 一次导航内完成：等待渲染 → 读状态 → 点击 → 轮询复核。
          // 编排器据此 receipt 区分 成功/跳过(wasCollected=false)/未知(not found)/失败(still collected)。
          const unfavOpts: Parameters<typeof driveUnfavorite>[0] = { page, ref };
          if (browserConfig.navigationTimeoutMs !== undefined) {
            unfavOpts.navigationTimeoutMs = browserConfig.navigationTimeoutMs;
          }
          const result = await driveUnfavorite(unfavOpts);
          return result;
        } finally {
          await page.close();
        }
      },
      verifyAction: async (ref) => {
        if (session === undefined) return { verified: false };
        const page = await session.newPage();
        try {
          const url = ref.canonicalUrl;
          if (url === undefined) return { verified: false };
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const collectBtn = page
            .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
            .first();
          try {
            await collectBtn.waitFor({ state: 'attached', timeout: 10_000 });
          } catch {
            return { verified: false };
          }
          // 弃用过时的 collected class，改用与 execute 一致的判定
          const collected = await inspectCollectedState(collectBtn);
          return { verified: collected === false };
        } finally {
          await page.close();
        }
      },
    },
    validateConfig: async () => ({ ok: true }),
    prepare: async () => {
      if (session !== undefined) {
        await session.launch();
      }
    },
    scan: async function* (_ctx) {
      if (session === undefined || browserConfig === undefined) return;
      void _ctx;
      const page = await session.newPage();
      try {
        const scanOpts: Parameters<typeof driveScanFavorites>[0] = {
          page,
          favoritesUrl: browserConfig.favoritesUrl ?? DEFAULT_FAVORITES_URL,
          baseUrl: DEFAULT_BASE_URL,
          sourceInstanceId: browserConfig.sourceInstanceId,
        };
        if (browserConfig.scanMaxEmptyCycles !== undefined) {
          scanOpts.maxEmptyCycles = browserConfig.scanMaxEmptyCycles;
        }
        if (browserConfig.scanWaitAfterScrollMs !== undefined) {
          scanOpts.waitAfterScrollMs = browserConfig.scanWaitAfterScrollMs;
        }
        if (browserConfig.navigationTimeoutMs !== undefined) {
          scanOpts.navigationTimeoutMs = browserConfig.navigationTimeoutMs;
        }
        if (browserConfig.maxScanItems !== undefined) {
          scanOpts.maxItems = browserConfig.maxScanItems;
        }
        const { refs } = await driveScanFavorites(scanOpts);
        for (const ref of refs) {
          yield ref;
        }
      } finally {
        await page.close();
      }
    },
    extract: async (ref, _ctx) => {
      void _ctx;
      if (session === undefined || browserConfig === undefined) {
        throw new Error(
          'createToutiaoSource().extract requires a real browser session; use fixture-driven wrapper for tests',
        );
      }
      // 定期重启浏览器上下文释放内存（防止 Playwright 累积 OOM）
      extractCount++;
      if (extractCount > RECYCLE_THRESHOLD) {
        extractCount = 0;
        await session.close();
        await session.launch();
      }
      const page = await session.newPage();
      try {
        const extractOpts: Parameters<typeof driveExtractDetail>[0] = { page, ref };
        if (browserConfig.navigationTimeoutMs !== undefined) {
          extractOpts.navigationTimeoutMs = browserConfig.navigationTimeoutMs;
        }
        if (browserConfig.maxImageBytes !== undefined) {
          extractOpts.maxImageBytes = browserConfig.maxImageBytes;
        }
        return await driveExtractDetail(extractOpts);
      } finally {
        await page.close();
      }
    },
    verifySourceRef: async (ref, _ctx) => {
      void _ctx;
      if (session === undefined || browserConfig === undefined) {
        return { resolvable: false, availability: 'unknown' as const };
      }
      const url = ref.canonicalUrl;
      if (url === undefined) {
        return { resolvable: false, availability: 'unknown' as const };
      }
      const page = await session.newPage();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const status = resp?.status() ?? 0;
        if (status === 404 || status === 410) {
          return { resolvable: false, availability: 'deleted' as const };
        }
        // 检查是否被重定向到登录页
        const currentUrl = page.url().toLowerCase();
        if (currentUrl.includes('login') || currentUrl.includes('passport')) {
          return { resolvable: false, availability: 'login_required' as const };
        }
        // 检查删除标记
        const hasDeletedMarker = await page
          .locator(SPECIAL_PAGE_SELECTORS.contentDeleted[0])
          .count()
          .catch(() => 0);
        if (hasDeletedMarker > 0) {
          return { resolvable: false, availability: 'deleted' as const };
        }
        return { resolvable: true, availability: 'available' as const };
      } catch {
        return { resolvable: false, availability: 'unknown' as const };
      } finally {
        await page.close();
      }
    },
    close: async () => {
      if (session !== undefined) {
        await session.close();
      }
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
