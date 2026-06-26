import type { Page } from 'playwright';
import type { SourceItemRef } from '@inkmigrate/core';
import { UNFAVORITE_SELECTORS } from '../selectors/index.js';

export interface UnfavoriteDriverOptions {
  page: Page;
  ref: SourceItemRef;
  /** 页面导航超时毫秒。 */
  navigationTimeoutMs?: number;
  /** 点击取消收藏后等待状态变化的毫秒数。 */
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

/**
 * §12.7 浏览器驱动的取消收藏操作。
 *
 * 流程：
 * 1. 导航到 ref.canonicalUrl（文章详情页），等待 networkidle。
 * 2. 查找收藏按钮（选择器见 UNFAVORITE_SELECTORS.collectButton）。
 * 3. 检查是否已收藏（class 含 collected）。
 * 4. 如果已收藏，点击按钮取消收藏。
 * 5. 等待 collected class 消失，确认取消成功。
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

  // 等待收藏按钮出现（候选选择器任一命中即可）
  const collectBtn = opts.page
    .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
    .first();
  const exists = await collectBtn.count().catch(() => 0);
  if (exists === 0) {
    return { success: false, wasCollected: false, isCollected: false, reason: 'collect button not found' };
  }

  // 检查当前收藏状态
  const collectedClass = UNFAVORITE_SELECTORS.collectedClass;
  const wasCollected = await collectBtn.evaluate(
    (el, cls) => el.classList.contains(cls),
    collectedClass,
  );

  if (!wasCollected) {
    // 本来就没收藏，无需操作
    return { success: true, wasCollected: false, isCollected: false };
  }

  // 点击取消收藏
  await collectBtn.click({ timeout: 5000 });

  // 等待 collected class 消失
  const waitMs = opts.waitAfterClickMs ?? 2000;
  await opts.page.waitForTimeout(waitMs);

  const isCollected = await collectBtn.evaluate(
    (el, cls) => el.classList.contains(cls),
    collectedClass,
  );

  return {
    success: !isCollected,
    wasCollected: true,
    isCollected,
    ...(isCollected ? { reason: 'still collected after click' } : {}),
  };
}
