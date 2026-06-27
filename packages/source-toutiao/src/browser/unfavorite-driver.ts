import type { Page } from 'playwright';
import type { SourceItemRef } from '@inkmigrate/core';
import { UNFAVORITE_SELECTORS } from '../selectors/index.js';

export interface UnfavoriteDriverOptions {
  page: Page;
  ref: SourceItemRef;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
  /** 点击取消收藏后，轮询确认状态变化的总窗口毫秒数。 */
  waitAfterClickMs?: number;
}

export interface UnfavoriteDriverResult {
  success: boolean;
  /** 操作前的收藏状态。 */
  wasCollected: boolean;
  /** 操作后的收藏状态。 */
  isCollected: boolean;
  /** 失败原因（success=false 时）。 */
  reason?: string;
}

/** 选择器参数包：aria-pressed 主信号 + collected class 回退。 */
interface StateReadParams {
  favorited: string;
  notFavorited: string;
  collectedClass: string;
}

const STATE_READ_PARAMS: StateReadParams = {
  favorited: UNFAVORITE_SELECTORS.favoritedAriaPressed,
  notFavorited: UNFAVORITE_SELECTORS.notFavoritedAriaPressed,
  collectedClass: UNFAVORITE_SELECTORS.collectedClass,
};

/**
 * §12.7 浏览器驱动的取消收藏操作（一次导航内完成全流程）。
 *
 * 流程：
 * 1. 导航到 ref.canonicalUrl，等待 domcontentloaded。
 * 2. 等待收藏按钮渲染（waitFor attached，根治 SPA 未渲染误判 not found）。
 * 3. 读 aria-pressed 判定收藏状态（主信号，根治 collected class 在真实页面不存在的误判）。
 * 4. 若已收藏：点击 → 在窗口内轮询确认 aria-pressed 转 false（根治固定等待导致的 still collected 误判）。
 * 5. 若本来就未收藏：直接返回 wasCollected=false（编排器据此计入"跳过"）。
 *
 * §12.7 安全要求：
 * - 只操作用户自己收藏的内容，不操作他人内容。
 * - 不批量自动点击（逐条确认）。
 * - 不使用坐标点击。
 */
export async function driveUnfavorite(
  opts: UnfavoriteDriverOptions,
): Promise<UnfavoriteDriverResult> {
  const url = opts.ref.canonicalUrl;
  if (url === undefined) {
    return { success: false, wasCollected: false, isCollected: false, reason: 'no canonicalUrl' };
  }

  await opts.page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: opts.navigationTimeoutMs ?? 30_000,
  });

  // 等待收藏按钮渲染：domcontentloaded 时 SPA 详情页可能尚未渲染按钮，
  // 瞬时 count() 会误判 not found（这是"未知"大量产生的根因）。
  const collectBtn = opts.page
    .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
    .first();
  try {
    await collectBtn.waitFor({
      state: 'attached',
      timeout: opts.navigationTimeoutMs ?? 10_000,
    });
  } catch {
    // 超时仍未渲染：用 count 复核，保留 not found 语义（编排器据此计入"未知"）
  }
  const exists = await collectBtn.count().catch(() => 0);
  if (exists === 0) {
    return { success: false, wasCollected: false, isCollected: false, reason: 'collect button not found' };
  }

  // 读操作前状态：aria-pressed 主信号，collected class 作回退
  const wasCollected = await readCollectedState(collectBtn);

  // 本来就未收藏，无需操作（编排器据此计入"跳过"）
  if (!wasCollected) {
    return { success: true, wasCollected: false, isCollected: false };
  }

  // 点击取消收藏
  await collectBtn.click({ timeout: 5_000 });

  // 在窗口内轮询确认 aria-pressed 转 false：避免固定等待在状态更新延迟/风控时误判"仍收藏"
  const windowMs = opts.waitAfterClickMs ?? 3_000;
  const pollIntervalMs = 500;
  const deadline = Date.now() + windowMs;
  let isCollected = true;
  while (Date.now() < deadline) {
    await opts.page.waitForTimeout(Math.min(pollIntervalMs, deadline - Date.now()));
    isCollected = await readCollectedState(collectBtn);
    if (!isCollected) break; // 一旦转未收藏立即确认，不必等满窗口
  }

  return {
    success: !isCollected,
    wasCollected: true,
    isCollected,
    ...(isCollected ? { reason: 'still collected after click' } : {}),
  };
}

/**
 * 只读检测收藏状态（不导航、不点击）。供 inspectActionState 复用，确保 inspect 与
 * execute 走同一套判定逻辑，消除二者历史上"inspect 用 collected class、execute 用
 * aria-pressed"的不一致。
 *
 * 调用方负责导航 + 等待渲染后传入按钮 locator。返回 null 表示按钮不存在。
 */
export async function inspectCollectedState(
  collectBtn: ReturnType<Page['locator']>,
): Promise<boolean | null> {
  const exists = await collectBtn.count().catch(() => 0);
  if (exists === 0) return null;
  return readCollectedState(collectBtn);
}

/** 读单个收藏按钮的收藏状态：aria-pressed 主信号（true=已收藏），collected class 回退。 */
async function readCollectedState(
  collectBtn: ReturnType<Page['locator']>,
): Promise<boolean> {
  return collectBtn.evaluate((el, params: StateReadParams) => {
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === params.favorited) return true;
    if (pressed === params.notFavorited) return false;
    return el.classList.contains(params.collectedClass);
  }, STATE_READ_PARAMS);
}
