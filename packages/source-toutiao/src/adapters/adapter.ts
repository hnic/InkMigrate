import {
  computeFingerprint,
  computeStableKey,
  type SourceAdapter,
  type SourceContentKind,
  type SourceItemRef,
} from '@inkmigrate/core';
import type { Page } from 'playwright';
import { TOUTIAO_CAPABILITIES, TOUTIAO_CLEANUP_ACTIONS } from '../capabilities.js';
import { deriveFingerprintInput } from '../normalize/fingerprint.js';
import { ToutiaoBrowserSession } from '../browser/browser-session.js';
import { driveScanFavorites } from '../browser/scan-driver.js';
import { driveExtractDetail } from '../browser/extract-driver.js';
import { driveUnfavorite, inspectCollectedState, waitForCollectedAttribute } from '../browser/unfavorite-driver.js';
import { SPECIAL_PAGE_SELECTORS, UNFAVORITE_SELECTORS } from '../selectors/index.js';

export const SOURCE_TOUTIAO_KIND = 'toutiao' as const;
export const SOURCE_TOUTIAO_VERSION = '1.0.0' as const;
export const SOURCE_TOUTIAO_ADAPTER_API_VERSION = '1.0.0' as const;

/** 默认收藏列表 URL。真实 URL 由配置或 CLI 提供。 */
const DEFAULT_FAVORITES_URL = 'https://www.toutiao.com/favorites';
const DEFAULT_BASE_URL = 'https://www.toutiao.com/';

/** inspect/verify 读取详情页的默认导航超时（未配置 navigationTimeoutMs 时）。 */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * 打开详情页并读取收藏按钮状态（cleanup 的 inspect/verify 共用，避免两路径
 * 各自维护一份 goto→waitFor→判定的序列而漂移）。返回：
 * - null：无法判定（无 canonicalUrl / 导航失败 / 按钮未渲染）；
 * - true：已收藏；false：未收藏。
 */
async function openDetailAndReadCollected(
  page: Page,
  ref: SourceItemRef,
  navigationTimeoutMs: number,
): Promise<boolean | null> {
  const url = ref.canonicalUrl;
  if (url === undefined) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  } catch {
    // 瞬时导航失败（超时/网络错误）降级为"无法判定"，不向清理管线抛异常
    return null;
  }
  const collectBtn = page
    .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
    .first();
  // 按钮等待预算与配置对齐：导航超时配置得比 10s 短时不该每条花 2×10s，
  // 配置得更长时按钮渲染等待也不必无限放大（10s 封顶）
  const waitMs = Math.min(navigationTimeoutMs, 10_000);
  try {
    // 等待渲染：domcontentloaded 时 SPA 详情页可能尚未渲染按钮（瞬时
    // count()=0 → 误判 unknown，是生产"未知"大量产生的根因）
    await collectBtn.waitFor({ state: 'attached', timeout: waitMs });
    // M-3: 与 execute 路径（driveUnfavorite）一致，等待 SPA hydration 写入
    // aria-pressed 属性，避免仅 attached 时 readCollectedState 回退到
    // 真实页面不存在的 collected class → 误判未收藏。
    await waitForCollectedAttribute(collectBtn, waitMs);
  } catch {
    // 超时则保留 not found → 无法判定
    return null;
  }
  return inspectCollectedState(collectBtn);
}

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
  /** 每处理多少条 extract 后重启浏览器上下文（防 OOM，内存 vs 重启成本的业务权衡）；默认 100。 */
  recycleThreshold?: number;
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
  // 防止 OOM：每处理 recycleThreshold 条重启浏览器上下文（业务可调，默认 100）
  let extractCount = 0;
  const recycleThreshold = browserConfig?.recycleThreshold ?? 100;
  // M11: recycle 互斥锁。config 允许 concurrency 到 3，但共享 session 的
  // close()/launch() 非并发安全——并发 extract B 的在飞 page 会被 recycle 杀掉。
  // 用 promise 锁串行化 recycle：recycle 期间其他 extract 等待，完成后用新 session。
  let recycleChain: Promise<void> = Promise.resolve();
  // close 后的闩锁：晚到的 extract/scan/cleanup 不得再入队——否则 close 与锁释放
  // 之间入队的操作会看到 !launched 而懒 launch 出一个无人关闭的新浏览器进程。
  let closed = false;

  /** 串行化执行可能触发 recycle 的 extract，避免 close/launch 与并发 page 互踩。 */
  async function withRecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    if (closed) throw new Error('toutiao adapter session already closed');
    // 把本次执行接到 recycleChain 末尾，保证串行
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = recycleChain;
    recycleChain = gate;
    await prev;
    // 拿到锁后再复核一次：排队期间 close 可能已置位（入队检查与实际执行之间存在窗口）
    if (closed) {
      release();
      throw new Error('toutiao adapter session already closed');
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 所有共享 session 的页面操作统一走 recycle 锁（M11 完整版：仅串行化
   * extract-vs-extract 不够，scan/cleanup 的在飞 page 同样会被跨阈值 recycle 的
   * close()/launch() 杀掉，close→launch 窗口内的 newPage() 还会抛 'not launched'）。
   */
  async function withSessionPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return withRecycleLock(async () => {
      // 兜底：recycle 中 launch 失败会丢失 context，而 launch() 只在 prepare()
      // 调一次；此处集中懒恢复让 scan/cleanup 消费方与 extract 一样自愈，
      // 而非永久失败 'not launched'。
      if (!session!.launched) {
        await session!.launch();
      }
      const page = await session!.newPage();
      try {
        return await fn(page);
      } finally {
        await page.close();
      }
    });
  }

  /**
   * 共享读取路径：inspect / verify 复用（同一 goto→waitFor→判定序列与超时口径），
   * 历史上两条路径各自维护一份而漂移过。返回 null 表示无法判定。
   * session 级异常（锁拒绝/recycle 失败后 newPage 抛出等）也降级为 null 而非
   * 向清理管线抛异常，与 openDetailAndReadCollected 吞掉导航失败的契约一致。
   */
  async function readCollectedForRef(ref: SourceItemRef): Promise<boolean | null> {
    try {
      return await withSessionPage((page) =>
        openDetailAndReadCollected(
          page,
          ref,
          browserConfig?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
        ),
      );
    } catch {
      return null;
    }
  }

  return {
    kind: SOURCE_TOUTIAO_KIND,
    version: SOURCE_TOUTIAO_VERSION,
    adapterApiVersion: SOURCE_TOUTIAO_ADAPTER_API_VERSION,
    capabilities: TOUTIAO_CAPABILITIES,
    // §12.1 v1.1 supportsSourceCleanup=true → cleanup 必须存在（§8.2 不变量）。
    // 支持的动作与 TOUTIAO_CAPABILITIES.cleanupActions 共用同一常量（单一事实来源）
    cleanup: {
      supportedActions: TOUTIAO_CLEANUP_ACTIONS,
      // inspect / execute / verify 三者通过 driveUnfavorite 的共享判定逻辑（aria-pressed
      // 主信号 + collected class 回退）保持状态读法一致；历史上 inspect/verify 用
      // collected class、execute 用 aria-pressed 的不一致已消除。
      inspectActionState: async (ref) => {
        if (session === undefined) return { state: 'unknown' as const };
        const collected = await readCollectedForRef(ref);
        if (collected === null) return { state: 'unknown' as const };
        return { state: collected ? 'favorited' as const : 'not-favorited' as const };
      },
      executeAction: async (ref, action) => {
        // 破坏性操作前校验动作类型：编排方传错 action 时不能照样取消收藏
        if (action !== 'unfavorite') {
          return { success: false, reason: `unsupported action: ${String(action)}` };
        }
        if (session === undefined || browserConfig === undefined) {
          return { success: false, reason: 'requires real browser session' };
        }
        return withSessionPage(async (page) => {
          // driveUnfavorite 一次导航内完成：等待渲染 → 读状态 → 点击 → 轮询复核。
          // 编排器据此 receipt 区分 成功/跳过(wasCollected=false)/未知(not found)/失败(still collected)。
          const unfavOpts: Parameters<typeof driveUnfavorite>[0] = { page, ref };
          if (browserConfig.navigationTimeoutMs !== undefined) {
            unfavOpts.navigationTimeoutMs = browserConfig.navigationTimeoutMs;
          }
          return driveUnfavorite(unfavOpts);
        });
      },
      verifyAction: async (ref) => {
        if (session === undefined) return { verified: false };
        const collected = await readCollectedForRef(ref);
        // 弃用过时的 collected class，改用与 execute 一致的判定
        return { verified: collected === false };
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
      // 与 extract 一致走 recycle 锁（复用 withSessionPage，含懒恢复）：
      // 扫描的在飞 page 不被并发 recycle 的 close/launch 杀掉。
      // driveScanFavorites 本就先滚完列表再一次性返回 refs，
      // 故锁内收集、锁外逐条 yield，行为不变。
      const refs = await withSessionPage(async (page) => {
        const scanOpts: Parameters<typeof driveScanFavorites>[0] = {
          page,
          favoritesUrl: browserConfig!.favoritesUrl ?? DEFAULT_FAVORITES_URL,
          baseUrl: DEFAULT_BASE_URL,
          sourceInstanceId: browserConfig!.sourceInstanceId,
        };
        if (browserConfig!.scanMaxEmptyCycles !== undefined) {
          scanOpts.maxEmptyCycles = browserConfig!.scanMaxEmptyCycles;
        }
        if (browserConfig!.scanWaitAfterScrollMs !== undefined) {
          scanOpts.waitAfterScrollMs = browserConfig!.scanWaitAfterScrollMs;
        }
        if (browserConfig!.navigationTimeoutMs !== undefined) {
          scanOpts.navigationTimeoutMs = browserConfig!.navigationTimeoutMs;
        }
        if (browserConfig!.maxScanItems !== undefined) {
          scanOpts.maxItems = browserConfig!.maxScanItems;
        }
        const { refs } = await driveScanFavorites(scanOpts);
        return refs;
      });
      for (const ref of refs) {
        yield ref;
      }
    },
    extract: async (ref, ctx) => {
      if (session === undefined || browserConfig === undefined) {
        throw new Error(
          'createToutiaoSource().extract requires a real browser session; use fixture-driven wrapper for tests',
        );
      }
      // H7: 若调用方传入已 abort 的 signal，在启动浏览器导航前快速失败，
      // 避免取消后仍发起一次完整 extract。进行中的导航由 navigationTimeoutMs 兜底。
      if (ctx.signal?.aborted) {
        throw new Error('aborted');
      }
      // M11: 包入 withRecycleLock 串行化，避免并发 extract 时 recycle 的 close/launch
      // 杀掉其他在飞 page（共享 context）。
      return withRecycleLock(async () => {
        // H7 补充：拿到锁后复核取消信号——排队等锁期间被取消的 extract 不应
        // 再启动一次完整的浏览器导航（顶部检查对排队场景失效）。
        if (ctx.signal?.aborted) {
          throw new Error('aborted');
        }
        // 兜底：recycle 中 launch 失败会丢失 context，而 launch() 只在 prepare()
        // 调一次；此处懒恢复让下一次 extract 自愈，而非永久失败 'not launched'。
        // （withSessionPage 内有同一兜底，extract 因 recycle 计数逻辑独享锁体，故保留一份）
        if (!session!.launched) {
          await session!.launch();
        }
        // 定期重启浏览器上下文释放内存（防止 Playwright 累积 OOM）
        extractCount++;
        if (extractCount > recycleThreshold) {
          extractCount = 0;
          await session!.close();
          await session!.launch();
        }
        const page = await session!.newPage();
        try {
          const extractOpts: Parameters<typeof driveExtractDetail>[0] = { page, ref };
          if (browserConfig!.navigationTimeoutMs !== undefined) {
            extractOpts.navigationTimeoutMs = browserConfig!.navigationTimeoutMs;
          }
          if (browserConfig!.maxImageBytes !== undefined) {
            extractOpts.maxImageBytes = browserConfig!.maxImageBytes;
          }
          return await driveExtractDetail(extractOpts);
        } finally {
          await page.close();
        }
      });
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
      return withSessionPage(async (page) => {
        try {
          const resp = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: browserConfig!.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
          });
          const status = resp?.status() ?? 0;
          if (status === 404 || status === 410) {
            return { resolvable: false, availability: 'deleted' as const };
          }
          // 403/429/5xx 或无响应（status 0）：页面并未真正加载，
          // 不能只因未命中登录/删除标记就谎报 available
          if (status === 0 || status >= 400) {
            return { resolvable: false, availability: 'unknown' as const };
          }
          // 检查是否被重定向到登录页：按主机名/路径判定而非全 URL 子串——
          // 正常文章 URL 的 path/query 含 "login"/"passport" 字样（slug、
          // ?login_hint= 等）会被子串匹配误判成 login_required（不可解）。
          // 口径与 unfavorite-driver.detectSpecialPage 的 URL 检测对齐
          //（其仍为子串匹配，见该文件）。
          const finalUrl = new URL(page.url());
          const host = finalUrl.hostname.toLowerCase();
          if (host.startsWith('passport.') || finalUrl.pathname.includes('/login')) {
            return { resolvable: false, availability: 'login_required' as const };
          }
          // 检查删除标记（L8: 用全部选择器 join，而非仅 [0]，与 unfavorite-driver 一致）
          const hasDeletedMarker = await page
            .locator(SPECIAL_PAGE_SELECTORS.contentDeleted.join(', '))
            .count()
            .catch(() => 0);
          if (hasDeletedMarker > 0) {
            return { resolvable: false, availability: 'deleted' as const };
          }
          return { resolvable: true, availability: 'available' as const };
        } catch {
          return { resolvable: false, availability: 'unknown' as const };
        }
      });
    },
    close: async () => {
      if (session === undefined || closed) return;
      // 在锁内关闭：既等在飞操作（extract/scan/cleanup）完成再关 session，
      // 避免 close 杀掉仍在执行的 page；也借闩锁拒绝 close 期间新入队的操作，
      // 防止晚到的操作懒 launch 出一个无人关闭的新浏览器进程（进程泄漏）。
      await withRecycleLock(async () => {
        closed = true;
        await session!.close();
      });
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
