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
  /**
   * 阅读模拟强度（防风控）：
   * - 'heavy'（默认）：按文章高度分段真实 wheel 滚动 + 每段随机停留 + 随机鼠标移动，
   *   模拟人类"打开→浏览→读完才取消收藏"的行为指纹。头条风控通过停留时长/滚动轨迹
   *   识别自动化，仅靠条目间间隔解决不了单条内的"机器感"。
   * - 'none'：不模拟（仅测试或已确认无风控时用）。
   */
  readingSimulation?: 'heavy' | 'none';
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

/** 区间 [min, max] 内的随机整数毫秒。 */
function randMs(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

/**
 * 模拟人类阅读：分段真实 wheel 滚动 + 每段随机停留 + 随机鼠标移动。
 *
 * 真实人打开文章会逐段往下读、有滚动有停留、鼠标会移动；纯"打开即点收藏按钮秒退"
 * 是头条风控识别自动化的强指纹。本函数让单条详情页的行为轨迹接近人类：
 * 1. 先随机停留（"看开头"）；
 * 2. 按视口高度分段向下 wheel 滚动，每段间随机停留 1-3 秒（"逐段阅读"）；
 * 3. 滚动过程中随机移动鼠标（人类不会全程静止）；
 * 4. 滚到底后随机回滚一段（"扫一眼"），再停留；
 * 5. 最后把视口滚回顶部附近（收藏按钮多在顶部/正文区）。
 *
 * 全程使用真实 wheel/mousemove 事件（非 JS scrollTo），让风控能观测到滚动交互。
 */
async function simulateReading(page: Page): Promise<void> {
  // 先在页面顶部随机停留（"读标题/开头"）
  await page.waitForTimeout(randMs(1500, 3500));

  // 测量可滚动高度与视口高度，决定滚动段数
  const dims = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));
  const viewport = dims.clientHeight > 0 ? dims.clientHeight : 800;
  const totalScrollable = Math.max(0, dims.scrollHeight - viewport);
  // 每段滚动约 0.6-1.0 个视口；总段数随内容长度增长，上限避免过长文章耗时失控
  const stepPx = Math.round(viewport * (0.6 + Math.random() * 0.4));
  const maxSteps = 8;
  const steps = Math.min(maxSteps, Math.ceil(totalScrollable / stepPx));

  let scrolled = 0;
  for (let i = 0; i < steps; i++) {
    // 随机移动鼠标到视口内某处（人类阅读时鼠标会动）
    const moveX = Math.round(100 + Math.random() * (viewport * 0.6));
    const moveY = Math.round(100 + Math.random() * 400);
    await page.mouse.move(moveX, moveY, { steps: 5 + Math.floor(Math.random() * 10) });

    // 真实 wheel 向下滚动一段
    await page.mouse.wheel(0, stepPx);
    scrolled += stepPx;

    // 每段停留（"读完这一段"），1.5-4 秒
    await page.waitForTimeout(randMs(1500, 4000));
  }

  // 偶尔（约 40%）回滚一段（"往回扫一眼"）
  if (Math.random() < 0.4 && steps > 0) {
    await page.mouse.wheel(0, -stepPx);
    await page.waitForTimeout(randMs(800, 2000));
  }

  // 滚回顶部附近（收藏按钮通常在正文区/顶部）
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
  // 点击前再停留一瞬（"决定要取消收藏"）
  await page.waitForTimeout(randMs(800, 2000));
}

/**
 * §12.7 浏览器驱动的取消收藏操作（一次导航内完成全流程，含阅读模拟）。
 *
 * 流程：
 * 1. 导航到 ref.canonicalUrl，等待 domcontentloaded。
 * 2. 等待收藏按钮渲染（waitFor attached，根治 SPA 未渲染误判 not found）。
 * 3. 读 aria-pressed 判定收藏状态（主信号，根治 collected class 误判）。
 * 4. 若已收藏：模拟人类阅读（heavy，默认）→ 点击 → 轮询确认 aria-pressed 转 false。
 *    未收藏的条目不模拟阅读（跳过项不是风控重点，速度优先）。
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

  // 本来就未收藏，无需操作（编排器据此计入"跳过"）。不模拟阅读：跳过项非风控重点。
  if (!wasCollected) {
    return { success: true, wasCollected: false, isCollected: false };
  }

  // 模拟人类阅读（heavy 默认）：模拟"打开→浏览→读完才取消"的行为指纹，降低风控识别。
  // 仅对将要操作的已收藏条目模拟，未收藏跳过项不模拟以节省时间。
  if (opts.readingSimulation !== 'none') {
    await simulateReading(opts.page);
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
