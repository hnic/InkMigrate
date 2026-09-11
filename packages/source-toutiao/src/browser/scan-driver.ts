import type { Page } from 'playwright';
import {
  scanFavoritesList,
  DEFAULT_MAX_EMPTY_CYCLES,
  type FavoriteItem,
  type ScanResult,
} from '../scan/scanner.js';
import { deriveFingerprintInput } from '../normalize/fingerprint.js';
import { computeFingerprint, type SourceItemRef, type SourceContentKind } from '@inkmigrate/core';
import { FAVORITES_SELECTORS } from '../selectors/favorites-list.js';

export interface ScanDriverOptions {
  page: Page;
  /** 收藏列表页面 URL。 */
  favoritesUrl: string;
  /** 用于 URL 解析的 baseUrl，通常 https://www.toutiao.com/ */
  baseUrl: string;
  /** 来源实例 ID（用于构造 SourceItemRef）。 */
  sourceInstanceId: string;
  /** 连续多少轮无新条目后终止（§12.5 默认 5）。 */
  maxEmptyCycles?: number;
  /** 每次滚动后等待页面稳定的毫秒数（§12.5）。 */
  waitAfterScrollMs?: number;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
  /**
   * 达到多少唯一条目后立即终止（不再滚动）。用于测试或限量迁移。
   * 注意：该计数发生在 video 过滤【之前】（scanner 以原始唯一条目计），
   * 过滤 video 后产出的 refs 可能少于 maxItems；需保证 N 条迁移候选时
   * 应按 video 占比放大该值。
   */
  maxItems?: number;
  /** 每轮滚动后的进度回调。 */
  onProgress?: (info: { found: number; scrollRound: number; phase: string }) => void;
  /** 取消检查回调（可选）。返回 true 时停止滚动并终止扫描。 */
  isCancelled?: () => boolean;
}

export interface ScanDriverResult {
  refs: SourceItemRef[];
  /** scanFavoritesList 返回的完整扫描统计。 */
  scanResult: ScanResult;
  /**
   * 提取轮次失败计数（初始提取 + 滚动轮重试后仍失败）。>0 表示扫描可能被
   * 截断：此时 scanResult.terminationReason 会追加 `_with_N_extraction_errors`
   * 后缀，调用方可据此区分"扫到底/没有收藏"与"页面故障导致的提前终止"。
   */
  extractionErrors: number;
}

/**
 * §12.4 + §12.5 浏览器驱动的收藏列表扫描。
 *
 * 流程：
 * 1. 导航到 favoritesUrl，等待 domcontentloaded（不等待 networkidle；SPA 列表
 *    异步渲染，未就绪时由空轮循环兜底）。
 * 2. 获取初始 HTML，交给 scanFavoritesList 解析。
 * 3. scrollForMore 回调：滚动到底部 → 等待 → 尝试点击"加载更多" → 返回新 HTML。
 * 4. scanner 负责去重和终止判断。
 * 5. 把 FavoriteItem 列表转为 SourceItemRef。
 *
 * 本函数只做浏览器编排（滚动、等待、点击），解析和去重由纯逻辑 scanner 完成。
 * buildRefFromFavorite 逻辑内联在此处，避免与 adapters/adapter.ts 形成循环依赖
 * （adapter.ts 导入本模块的 driveScanFavorites）。
 */
export async function driveScanFavorites(
  opts: ScanDriverOptions,
): Promise<ScanDriverResult> {
  try {
    await opts.page.goto(opts.favoritesUrl, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navigationTimeoutMs ?? 30_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`toutiao: favorites page navigation failed (${opts.favoritesUrl}): ${msg}`);
  }
  // 会话过期时收藏页会被静默重定向到登录/passport 页，随后扫出 0 条且终止原因
  // 看似正常（连续空轮），调用方无法区分"没有收藏"和"未登录"。与
  // adapter.verifySourceRef 同口径：URL 含 login/passport 即快速失败。
  const afterUrl = opts.page.url().toLowerCase();
  if (afterUrl.includes('login') || afterUrl.includes('passport')) {
    throw new Error(
      `toutiao: favorites page redirected to login page (login required): ${afterUrl}`,
    );
  }
  // 死链/改版迁移的收藏 URL 以 404 页响应但 goto 正常完成（DEFAULT_FAVORITES_URL
  // 的 /favorites 2026-09 实测已 404），不识别会走空轮循环"正常"终止——调用方
  // 无法区分「没有收藏」和「URL 已失效」。title 是 404 页的稳定标记（正常收藏页
  // title 为「我的收藏 - 今日头条」），与 login/passport 重定向同口径快速失败
  const pageTitle = (await opts.page.title()).trim();
  if (pageTitle.includes('404') || /not found/i.test(pageTitle)) {
    throw new Error(
      `toutiao: favorites page is 404 (URL 已失效?): ${opts.favoritesUrl}`,
    );
  }

  /**
   * 增量提取：每轮只返回 DOM 中【新出现】的收藏条目 HTML。
   * Node 端维护 seen Set，每次 evaluate 传入已知的 key 列表，
   * 浏览器端只返回未在 knownKeys 中的条目。
   * 避免 window 全局变量在页面刷新时丢失的风险。
   */
  const nodeSeen = new Set<string>();
  const extractItemsHtml = async (): Promise<string> => {
    const knownKeys = Array.from(nodeSeen);
    const result = await opts.page.evaluate(
      (params: { selectorsJson: string; knownJson: string; baseUrl: string }) => {
        const selectors = JSON.parse(params.selectorsJson) as string[];
        const known = new Set(JSON.parse(params.knownJson) as string[]);
        const baseUrl = params.baseUrl;

        // §缺陷3 去重 key 必须与 Node 端 scanner 同口径，否则同一收藏项因
        // href 中 query/追踪参数差异被浏览器端误判为"新条目"传回 Node，
        // 再被 Node 端归一化去重丢弃 → 本轮 newInThisRound=0 → 连续多轮
        // 触发 emptyCycles>=5 提前终止（扫描尚未到底）。
        // 口径 = externalId ?? canonicalUrl，其中 externalId 优先读条目容器的
        // data-item-id 属性（与 scanner.parseItemsFromHtml 一致），无属性时才
        // 从 URL 派生（复刻 src/normalize/dedupe-key.ts）。page.evaluate 在浏览器
        // 上下文执行，无法闭包引用 Node 端 import，故在此内联；修改时务必同步
        // 两处 + tests/normalize/dedupe-key.test.ts。
        const TRACKING_PARAMS = new Set([
          'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
          'from', 'source', 'log_from', 'wid', 'share_token', 'appshare',
        ]);
        function canonicalizeUrl(raw: string): string {
          try {
            const u = new URL(raw);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
            // 仅头条域名剥参（与 Node 端 canonicalizeToutiaoUrl 同口径）：非头条域名
            // 的 from/source 可能是功能性参数而非追踪参数，误剥会造成两侧 key 漂移
            const h = u.hostname;
            if (h !== 'toutiao.com' && !h.endsWith('.toutiao.com')) return raw;
            u.hash = '';
            for (const k of [...u.searchParams.keys()]) {
              // 键名小写比对：From=/UTM_Source= 等变体需与 Node 端一致剥除，
              // 否则 DOM 重渲染换参数大小写后浏览器端误判"新条目"→ Node 归一化
              // 去重丢弃 → 空轮累积 → 提前终止（§缺陷3 复发）
              if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
            }
            return u.toString();
          } catch {
            return raw;
          }
        }
        function extractContentId(url: string): string | undefined {
          try {
            const u = new URL(url);
            // 精确匹配 toutiao.com 或 *.toutiao.com：endsWith('toutiao.com') 会误吞
            // notoutiao.com 等外部域名，其 /article/<id> 路径会与真实头条内容 id
            // 在去重 key 上碰撞
            if (u.hostname !== 'toutiao.com' && !u.hostname.endsWith('.toutiao.com')) {
              return undefined;
            }
            // §9 移动端分享短链接 /is/<digits>/（与 extractToutiaoContentId 保持同口径）
            const sl = /\/is\/(\d+)(?:\/|$)/.exec(u.pathname);
            if (sl) return sl[1];
            // M3: 与 normalize/url.ts:extractToutiaoContentId 保持同口径，含 /a/<id>/（新文章路径）。
            // 原浏览器端漏了 'a'，与 Node 端漂移——正是注释警告的「务必同步两处」已发生。
            const m = /\/(article|a|wenda|video|group|w)\/(\d+)/.exec(u.pathname);
            return m?.[2];
          } catch {
            return undefined;
          }
        }
        function dedupeKey(href: string): string {
          let abs: string;
          try {
            abs = new URL(href, baseUrl).toString();
          } catch {
            abs = href;
          }
          const canonical = canonicalizeUrl(abs);
          return extractContentId(canonical) ?? canonical;
        }

        // 合并【所有】条目选择器的并集去重。
        // 同一收藏页混合出现视频/文章/微头条，外层容器 class 不同，
        // 取第一个非空选择器会漏掉其它类型（曾因此只抓到微头条、漏掉视频）。
        const seen = new Set<Element>();
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) seen.add(el);
        }
        const allEls = Array.from(seen);

        // 收集本轮新出现的条目 + 它们的 key
        const newEls: Element[] = [];
        const newKeys: string[] = [];
        for (const el of allEls) {
          const link = el.querySelector(
            'a[href*="/article/"], a[href*="/a/"], a[href*="/video/"], a[href*="/wenda/"], a[href*="/group/"], a[href*="/w/"]',
          );
          const href = link?.getAttribute('href');
          if (href === null || href === undefined) {
            // 无内容链接的条目（骨架/占位等）不发送：Node 端会把它解析成
            // canonicalUrl=收藏页本身的垃圾条目；此前用文本兜底 key 也不稳定
            //（时间戳变化/前缀碰撞会永久污染 seen）。等后续轮次 hydration
            // 出现真实链接后，再按 URL 派生 key 正常发送。
            continue;
          }
          // 与 Node 端 scanner 同口径（key = externalId ?? canonicalUrl）：
          // 优先 data-item-id（scanner 的 externalId 直读该属性），其次 URL 派生
          // id/canonicalUrl。两侧口径不同会导致同一元素被重复发送或提前终止。
          // 注意 '' 的处理：getAttribute 的 '' 非 nullish，Node 端 scanner 会把
          // externalId='' 当作存在（key=''），此处保持同口径（'' 也直接作 key），
          // 避免空值条目在两侧 key 分裂后重复发送、徒增空轮。
          const attrId = el.getAttribute('data-item-id');
          const key = attrId !== null ? attrId : dedupeKey(href);
          if (!known.has(key)) {
            newEls.push(el);
            newKeys.push(key);
          }
        }

        const wrapper = document.createElement('div');
        for (const el of newEls) wrapper.appendChild(el.cloneNode(true));
        return { html: wrapper.innerHTML, newKeys };
      },
      {
        selectorsJson: JSON.stringify(FAVORITES_SELECTORS.item),
        knownJson: JSON.stringify(knownKeys),
        baseUrl: opts.baseUrl,
      },
    );
    // 在 Node 端更新 seen（页面刷新不会丢失）
    for (const k of result.newKeys) {
      nodeSeen.add(k);
    }
    return result.html;
  };

  let extractionErrors = 0;
  let initialHtml: string;
  try {
    initialHtml = await extractItemsHtml();
  } catch {
    // 首轮提取失败（页面仍在跳转/执行上下文销毁）：等新文档就绪后重试一次
    //（与 scrollForMore 的恢复路径同款），仍失败才以空 HTML 起步并计数——
    // 由后续滚动轮次与空轮循环兜底，同时 extractionErrors 保证"空结果"
    // 可被判别为页面故障而非"没有收藏"
    await opts.page.waitForLoadState('domcontentloaded').catch(() => {});
    try {
      initialHtml = await extractItemsHtml();
    } catch {
      extractionErrors++;
      initialHtml = '';
    }
  }
  const waitMs = opts.waitAfterScrollMs ?? 1500;
  let scrollRound = 0;

  const scrollForMore = async (): Promise<string | null> => {
    scrollRound++;
    // 进度通知：开始滚动
    if (opts.onProgress !== undefined) {
      opts.onProgress({ found: nodeSeen.size, scrollRound, phase: 'scrolling' });
    }

    /** 提取本轮新条目并通知进度。失败向上抛，由调用方决定重试或终止。 */
    const extractAfterScroll = async (): Promise<string> => {
      const html = await extractItemsHtml();
      if (opts.onProgress !== undefined) {
        opts.onProgress({ found: nodeSeen.size, scrollRound, phase: 'loaded' });
      }
      return html;
    };

    try {
      // §12.5 滚动到底部
      await opts.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await opts.page.waitForTimeout(waitMs);

      // §12.5 尝试点击"加载更多"按钮（如果可见）
      const loadMoreSelectors = FAVORITES_SELECTORS.loadMore;
      for (const sel of loadMoreSelectors) {
        const locator = opts.page.locator(sel).first();
        const visible = await locator.isVisible().catch(() => false);
        if (visible) {
          await locator.click({ timeout: 2000 }).catch(() => {});
          await opts.page.waitForTimeout(waitMs);
          break;
        }
      }

      return await extractAfterScroll();
    } catch {
      // 点击可能触发导航销毁执行上下文（"Execution context was destroyed"），
      // 滚动/提取调用也会因页面跳转或关闭而抛错。等新文档就绪后重试一次提取；
      // 仍失败则按"无更多"终止，保留已累计条目——不能让第 N 轮的瞬时失败
      // 把前 N-1 轮的扫描结果整批丢弃。
      await opts.page.waitForLoadState('domcontentloaded').catch(() => {});
      try {
        return await extractAfterScroll();
      } catch {
        // null 与"无更多"共用返回值（scanner 契约，保留已累计条目），但计入
        // 失败数：终止原因会带后缀，截断的扫描不会伪装成完整扫描
        extractionErrors++;
        return null;
      }
    }
  };

  const scanInput: Parameters<typeof scanFavoritesList>[0] = {
    initialHtml,
    baseUrl: opts.baseUrl,
    scrollForMore,
    maxEmptyCycles: opts.maxEmptyCycles ?? DEFAULT_MAX_EMPTY_CYCLES,
    ...(opts.isCancelled !== undefined ? { isCancelled: opts.isCancelled } : {}),
  };
  if (opts.maxItems !== undefined) {
    scanInput.maxItems = opts.maxItems;
  }
  const scanResult = await scanFavoritesList(scanInput);
  if (extractionErrors > 0) {
    // 可观测性：返回 null 与"无更多内容"在 scanner 契约里不可区分（都会记
    // no_load_more），被瞬时提取失败截断的扫描不能以"完整扫描"的面目到达
    // 调用方/报告。追加后缀而非改写原值，保留 no_new_items/no_load_more 语义
    scanResult.terminationReason += `_with_${extractionErrors}_extraction_errors`;
  }

  // 过滤无法转 markdown 笔记的内容类型。video 无正文文本（详情页是播放器），
  // 迁移出来只会是空壳/降级笔记，故在成为候选前剔除。保留文本类
  // （article/short-post/gallery/question-answer/note/unknown）。
  // 仅过滤 refs（迁移候选）：scanResult.items/uniqueItems 保留原始扫描发现，
  // 以便报告/日志反映"扫到 N 条，其中 video 已跳过"，不破坏并集抓取可观测性。
  const EXCLUDED_KINDS = new Set<SourceContentKind>(['video']);
  const discoveredAt = new Date().toISOString();
  const refs: SourceItemRef[] = scanResult.items
    .filter((fav) => !EXCLUDED_KINDS.has(fav.contentKind))
    .map((fav) => buildRefInline(opts.sourceInstanceId, fav, discoveredAt));

  return { refs, scanResult, extractionErrors };
}

/**
 * 从 FavoriteItem 构造 SourceItemRef。与 adapters/adapter.ts 中的 buildRefFromFavorite
 * 逻辑相同，内联在此处以避免循环依赖（adapter.ts 导入本模块）。
 * 这是手工同步的两份实现：fingerprint 输入或 SourceItemRef 字段变动时，
 * 改动任一份务必同步核对另一份，否则两侧会静默漂移产出不一致的 ref。
 */
function buildRefInline(
  sourceInstanceId: string,
  favorite: FavoriteItem,
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
