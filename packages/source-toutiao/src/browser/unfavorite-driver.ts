import type { Page } from 'playwright';
import type { SourceItemRef } from '@inkmigrate/core';
import { UNFAVORITE_SELECTORS, SPECIAL_PAGE_SELECTORS } from '../selectors/index.js';

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
  /**
   * 可注入的随机数生成器 [0,1)（默认 Math.random）。供 simulateReading 的
   * 停留时长/滚动段数/鼠标移动等随机行为用，使这条最复杂的反检测逻辑在测试中
   * 可确定性断言（固定种子），而非全靠不可控的 Math.random。
   */
  rng?: () => number;
}

export interface UnfavoriteDriverResult {
  success: boolean;
  /** 操作前的收藏状态。 */
  wasCollected: boolean;
  /** 操作后的收藏状态。 */
  isCollected: boolean;
  /** 失败原因（success=false 时）。 */
  reason?: string;
  /**
   * §5/§14.12 检测到的特殊页面状态（登录墙/风控挑战/内容不可用）。
   * 命中时 success=false、reason 为对应状态码，编排器据此受控中断。
   */
  detectedState?: 'login_required' | 'challenge_required' | 'content_unavailable';
}

/** 选择器参数包：aria-pressed 显式取值（true=已收藏 / false=未收藏）。 */
interface StateReadParams {
  favorited: string;
  notFavorited: string;
}

const STATE_READ_PARAMS: StateReadParams = {
  favorited: UNFAVORITE_SELECTORS.favoritedAriaPressed,
  notFavorited: UNFAVORITE_SELECTORS.notFavoritedAriaPressed,
};

/** 默认 RNG（Math.random）。可被 options.rng 注入替换以便测试。 */
const defaultRng = Math.random;

// —— 防风控节奏参数（集中命名，调优不必在两个函数里翻找字面量）——
/** 取消收藏点击（含 actionability 等待）的上限毫秒。 */
const CLICK_TIMEOUT_MS = 5_000;
/** 点击后轮询确认 aria-pressed 变化的间隔毫秒。 */
const POLL_INTERVAL_MS = 500;
/** 阅读模拟：开头停留范围 [min, max] 毫秒（"读标题/开头"）。 */
const READING_OPEN_DWELL_MS: readonly [number, number] = [1500, 3500];
/** 阅读模拟：段间停留范围（"逐段阅读"）。 */
const READING_STEP_DWELL_MS: readonly [number, number] = [1500, 4000];
/** 阅读模拟：短停留范围（回滚后"扫一眼"/点击前"决定取消"）。 */
const READING_SHORT_DWELL_MS: readonly [number, number] = [800, 2000];
/** 阅读模拟：最多滚动段数（过长文章的耗时失控上限）。 */
const READING_MAX_STEPS = 8;
/** 阅读模拟：滚到底后回滚一段的概率。 */
const READING_ROLLBACK_PROBABILITY = 0.4;

/** 区间 [min, max] 内的随机整数毫秒。 */
function randMs(
  [min, max]: readonly [number, number],
  rng: () => number,
): number {
  return Math.round(min + rng() * (max - min));
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
 * 除第 5 步外全程使用真实 wheel/mousemove 事件（非 JS scrollTo），让风控能
 * 观测到滚动交互；第 5 步的一次瞬时 scrollTo 是耗时与拟人的折中（见该处注释）。
 *
 * rng 可注入：默认 Math.random；测试传入固定种子 PRNG 可对段数/停留/鼠标轨迹
 * 做确定性断言，让这条最复杂的反检测逻辑从"完全无测试覆盖"变为可测。
 */
async function simulateReading(page: Page, rng: () => number = defaultRng): Promise<void> {
  // 先在页面顶部随机停留（"读标题/开头"）
  await page.waitForTimeout(randMs(READING_OPEN_DWELL_MS, rng));

  // 测量可滚动高度与视口尺寸，决定滚动段数
  const dims = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
  }));
  const viewport = dims.clientHeight > 0 ? dims.clientHeight : 800;
  // 鼠标 X 轴以视口【宽度】为基准：窄长视口（如移动端 360×800）下若误用高度，
  // 坐标会落在页面之外——页外坐标本身就是一种自动化指纹
  const viewportWidth = dims.clientWidth > 0 ? dims.clientWidth : 1280;
  const totalScrollable = Math.max(0, dims.scrollHeight - viewport);
  // 每段滚动约 0.6-1.0 个视口；总段数随内容长度增长，上限避免过长文章耗时失控
  const stepPx = Math.round(viewport * (0.6 + rng() * 0.4));
  const steps = Math.min(READING_MAX_STEPS, Math.ceil(totalScrollable / stepPx));

  for (let i = 0; i < steps; i++) {
    // 随机移动鼠标到视口内某处（人类阅读时鼠标会动）
    const moveX = Math.round(100 + rng() * (viewportWidth * 0.6));
    const moveY = Math.round(100 + rng() * 400);
    await page.mouse.move(moveX, moveY, { steps: 5 + Math.floor(rng() * 10) });

    // 真实 wheel 向下滚动一段
    await page.mouse.wheel(0, stepPx);

    // 每段停留（"读完这一段"）
    await page.waitForTimeout(randMs(READING_STEP_DWELL_MS, rng));
  }

  // 偶尔回滚一段（"往回扫一眼"）
  if (rng() < READING_ROLLBACK_PROBABILITY && steps > 0) {
    await page.mouse.wheel(0, -stepPx);
    await page.waitForTimeout(randMs(READING_SHORT_DWELL_MS, rng));
  }

  // 滚回顶部附近（收藏按钮通常在正文区/顶部）。已知的拟人性偏离：这里用一次
  // instant scrollTo 而非连续负向 wheel——清理动辄上千条，逐段 wheel 回滚会显著
  // 拉长单条耗时；瞬时跳转的暴露面由前后随机停留与点击后的状态轮询兜底。
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
  // 点击前再停留一瞬（"决定要取消收藏"）
  await page.waitForTimeout(randMs(READING_SHORT_DWELL_MS, rng));
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

  try {
    await opts.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navigationTimeoutMs ?? 30_000,
    });
  } catch {
    // 结果契约：导航失败（超时/网络错误/ERR_ABORTED）返回结构化失败回执，
    // 不让原始异常逃出 driveUnfavorite——编排器按 reason 做四类映射与重试决策
    return { success: false, wasCollected: false, isCollected: false, reason: 'navigation_failed' };
  }

  // §5/§14.12 特殊页面检测（登录墙/风控挑战/内容不可用）：在等待收藏按钮前先识别。
  // 命中即提前返回 success=false + detectedState，编排器据此受控中断（而非把
  // 按钮未渲染误判为 unknown，或把风控页的不可点按钮当 hardFailed 触发 15 分钟硬等）。
  const detected = await detectSpecialPage(opts.page);
  if (detected !== undefined) {
    return {
      success: false,
      wasCollected: false,
      isCollected: false,
      reason: detected,
      detectedState: detected,
    };
  }

  // 等待收藏按钮渲染：domcontentloaded 时 SPA 详情页可能尚未渲染按钮，
  // 瞬时 count() 会误判 not found（这是"未知"大量产生的根因）。
  const collectBtn = opts.page
    .locator(UNFAVORITE_SELECTORS.collectButton.join(', '))
    .first();
  try {
    // C9: 不只等 'attached'（元素在 DOM 但 SPA 可能尚未 hydration 写入 aria-pressed），
    // 而是等到 aria-pressed 属性出现，避免读到缺失值后回退到已知失效的 class 判定，
    // 后者会把"实际仍收藏"误判为"未收藏"→ 落库 already_unfavorited 终态 → 永久遗漏清理目标。
    await collectBtn.waitFor({
      state: 'attached',
      timeout: opts.navigationTimeoutMs ?? 10_000,
    });
    await waitForCollectedAttribute(collectBtn, opts.navigationTimeoutMs ?? 10_000);
  } catch {
    // 超时仍未渲染：用 count 复核，保留 not found 语义（编排器据此计入"未知"）
  }
  const exists = await collectBtn.count().catch(() => 0);
  if (exists === 0) {
    return { success: false, wasCollected: false, isCollected: false, reason: 'collect button not found' };
  }

  // 读操作前状态：aria-pressed 主信号。null = 属性缺失（SPA 未 hydration/改版），
  // 绝不能默认"未收藏"——那会把实际仍收藏的条目误报 already_unfavorited 终态、
  // 永久漏清；也不能盲点击（aria-pressed 是切换按钮，误点可能反向收藏）。
  // ref 本身来自收藏扫描（先验已收藏），按失败上报交由编排器重试/人工介入。
  const wasCollected = await readCollectedState(collectBtn);
  if (wasCollected === null) {
    return {
      success: false,
      wasCollected: true,
      isCollected: true,
      reason: 'collect state unknown (aria-pressed missing)',
    };
  }

  // 本来就未收藏，无需操作（编排器据此计入"跳过"）。不模拟阅读：跳过项非风控重点。
  if (!wasCollected) {
    return { success: true, wasCollected: false, isCollected: false };
  }

  // 模拟人类阅读（heavy 默认）：模拟"打开→浏览→读完才取消"的行为指纹，降低风控识别。
  // 仅对将要操作的已收藏条目模拟，未收藏跳过项不模拟以节省时间。
  if (opts.readingSimulation !== 'none') {
    await simulateReading(opts.page, opts.rng ?? defaultRng);
  }

  // 点击取消收藏
  try {
    await collectBtn.click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    // 结果契约：点击失败（超时/不可点/元素分离）返回结构化失败回执
    return { success: false, wasCollected: true, isCollected: true, reason: 'click_failed' };
  }

  // 在窗口内轮询确认 aria-pressed 转 false：避免固定等待在状态更新延迟/风控时误判"仍收藏"
  const windowMs = opts.waitAfterClickMs ?? 3_000;
  const deadline = Date.now() + windowMs;
  let isCollected = true;
  while (Date.now() < deadline) {
    await opts.page.waitForTimeout(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    // 元素被 SPA 重渲染替换时 evaluate 抛错、aria-pressed 瞬时缺失时返回 null：
    // 两种"读不到"都保守视为仍收藏，绝不把未知当"已取消"误报成功
    isCollected = (await readCollectedState(collectBtn).catch(() => null)) ?? true;
    if (!isCollected) break; // 仅显式 notFavorited 才确认成功，不必等满窗口
  }

  return {
    success: !isCollected,
    wasCollected: true,
    isCollected,
    ...(isCollected ? { reason: 'still collected after click' } : {}),
  };
}

/**
 * §5/§14.12 检测特殊页面状态（登录墙/风控挑战/内容不可用）。
 *
 * 判定顺序与 adapter.verifySourceRef 一致：
 * 1. URL 含 login/passport → 登录墙（被重定向到登录页）
 * 2. 安全验证选择器命中 → 风控挑战（验证码）
 * 3. 内容删除/不可用标记命中 → 内容不可用
 *
 * 命中即返回对应状态码；均未命中返回 undefined（正常内容页，继续 unfavorite 流程）。
 * 这套检测能力此前只在 verifySourceRef（校验路径）实现，cleanup 执行路径漏检，
 * 导致登录/风控被误判为"按钮未找到（unknown）"或"点击后仍收藏（hardFailed）"。
 */
async function detectSpecialPage(
  page: Page,
): Promise<'login_required' | 'challenge_required' | 'content_unavailable' | undefined> {
  // 1. URL 重定向到登录/passport
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes('login') || currentUrl.includes('passport')) {
    return 'login_required';
  }
  // 2. C8: 风控挑战（验证码）。原实现只用 fixture testid `[data-testid="security-challenge"]`，
  // 真实头条页面不存在该 testid → 撞到真实验证码页时永不命中 → 不中断 → 继续下一条，
  // 或在风控期内反复操作导致封号。补充 URL 模式（verify/captcha/safe/sec）与真实页面
  // 候选选择器（iframe.captcha、含验证码/安全验证文案的元素）。
  if (/\/(verify|captcha|safe|sec)\b/i.test(currentUrl)) {
    return 'challenge_required';
  }
  const challengeSelectors = SPECIAL_PAGE_SELECTORS.securityChallenge.join(', ');
  const challengeCount = await page
    .locator(challengeSelectors)
    .count()
    .catch(() => 0);
  if (challengeCount > 0) {
    return 'challenge_required';
  }
  // 3. 内容删除/不可用（遍历所有候选选择器，而非仅 [0]）
  const deletedSelectors = SPECIAL_PAGE_SELECTORS.contentDeleted.join(', ');
  const deletedCount = await page
    .locator(deletedSelectors)
    .count()
    .catch(() => 0);
  if (deletedCount > 0) {
    return 'content_unavailable';
  }
  return undefined;
}

/**
 * 只读检测收藏状态（不导航、不点击）。供 inspectActionState 复用，确保 inspect 与
 * execute 走同一套判定逻辑，消除二者历史上"inspect 用 collected class、execute 用
 * aria-pressed"的不一致。
 *
 * 调用方负责导航 + 等待渲染后传入按钮 locator。返回 null 表示按钮不存在
 * 或状态未知（aria-pressed 缺失，见 readCollectedState）。
 */
export async function inspectCollectedState(
  collectBtn: ReturnType<Page['locator']>,
): Promise<boolean | null> {
  const exists = await collectBtn.count().catch(() => 0);
  if (exists === 0) return null;
  return readCollectedState(collectBtn);
}

/**
 * C9: 等待收藏按钮的 aria-pressed 属性出现（SPA hydration 完成的信号）。
 * 仅 attached 不保证 hydration 已写入状态属性。读到缺失值会回退到 class 判定，
 * 而真实页面按钮不带 collected class（selectors 注释已声明），导致误判"未收藏"。
 * 这里轮询直到属性出现或超时，超时则回退（保留原行为，但给 SPA 足够 hydration 时间）。
 */
export async function waitForCollectedAttribute(
  collectBtn: ReturnType<Page['locator']>,
  timeoutMs: number,
): Promise<void> {
  await collectBtn
    .page()
    .waitForFunction(
      (locator) => {
        const el = document.querySelector(locator);
        if (el === null) return false;
        return el.getAttribute('aria-pressed') !== null;
      },
      UNFAVORITE_SELECTORS.collectButton.join(', '),
      { timeout: timeoutMs },
    )
    .catch(() => {
      // 超时容忍：回退到 readCollectedState 的既有逻辑
    });
}

/**
 * C9: 读单个收藏按钮的收藏状态：aria-pressed 主信号（true/false 显式判定）。
 * 返回 null = aria-pressed 缺失（未知）：真实页面按钮【不】带 collected class
 * （selectors 注释已声明），class 回退只会把"实际仍收藏"误判为"未收藏"，
 * 故属性缺失时宁可返回未知，由调用方保守处理（轮询视为仍收藏/整体报失败）。
 */
async function readCollectedState(
  collectBtn: ReturnType<Page['locator']>,
): Promise<boolean | null> {
  return collectBtn.evaluate((el, params: StateReadParams) => {
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === params.favorited) return true;
    if (pressed === params.notFavorited) return false;
    // aria-pressed 缺失 = 未知；真实页面无 collected class，绝不能默认"未收藏"
    return null;
  }, STATE_READ_PARAMS);
}
