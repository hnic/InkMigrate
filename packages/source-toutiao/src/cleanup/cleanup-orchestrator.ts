import type { DB, SourceAdapter, SourceItemRef, CleanupContext } from '@inkmigrate/core';
import {
  CleanupPlans,
  CleanupJobs,
  CleanupItems,
  CleanupAttempts,
  ACTION_STATUS_UNFAVORITED,
  ACTION_STATUS_ALREADY_UNFAVORITED,
  withJitter,
  ITEM_INTERVAL_JITTER,
  sourceContentHash,
} from '@inkmigrate/core';
import { type PreActionState } from './cleanup-state-machine.js';
import { generateCleanupPlan } from './plan-generator.js';

export interface CleanupProgress {
  phase: 'cleanup';
  current: number;
  total: number;
  currentItem?: string;
}

export interface CleanupLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CleanupOrchestratorOptions {
  db: DB;
  /** 已 prepare 完毕的源适配器（含 .cleanup）。调用方负责 prepare/close。 */
  sourceAdapter: SourceAdapter;
  sourceInstanceId: string;
  /** 关联的迁移任务 ID（满足 cleanup_plans.migration_job_id FK）。 */
  migrationJobId: string;
  workspaceDir: string;
  /** 单次最多处理条目数。留空=DEFAULT_CLEANUP_MAX_ITEMS（防风控）。 */
  maxItems?: number;
  /** 条目间基准间隔毫秒（叠加 ±40% 抖动）。留空=DEFAULT_CLEANUP_INTERVAL_MS。 */
  intervalMs?: number;
  onProgress?: (p: CleanupProgress) => void;
  onLog?: (entry: CleanupLogEntry) => void;
  /** 取消检查回调（可选）。循环每轮检查，返回 true 时优雅终止并落库部分结果。 */
  isCancelled?: () => boolean;
  /**
   * 可注入的 sleep 函数（默认真实 setTimeout）。条目间等待用它，便于测试
   * 断言节奏而不真等。签名：(ms) => Promise<void>。
   */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface CleanupOrchestratorResult {
  jobId: string;
  planId: string;
  successCount: number;
  skippedCount: number;
  failedCount: number;
  unknownCount: number;
  /** §5/§14.12 因登录墙/风控挑战而受控中断的条目数。 */
  loginPauseCount: number;
  /** §5/§14.12 受控中断原因（login_required / challenge_required），无则 undefined。 */
  pauseReason?: string;
}

/** 每种失败原因只打印前几条样例，避免日志刷屏。 */
const REASON_SAMPLE_LIMIT = 3;

/**
 * §18.1 cleanup 节奏默认值（防风控）。
 * 实测规则：单日批量清理 ≤200 条更安全；条目间需有间隔避免"连点"触发限流。
 * scan/extract/migrate 已有同款抖动，cleanup 此前遗漏，此处补齐。
 */
const DEFAULT_CLEANUP_MAX_ITEMS = 200;
const DEFAULT_CLEANUP_INTERVAL_MS = 2000;

/**
 * 失败后递增重试的节奏。
 *
 * 需求：出现取消收藏失败（风控等）时，不连续处理后续，原地等待冷却后重试；
 * 每次重试前等待时长递增（第 1 次重试前等 BASE 分钟、第 2 次等 BASE×2 分钟、
 * 第 3 次等 BASE×3 分钟……），给累积的风控信号更长的冷却窗口。
 *
 * 重试上限 MAX_RETRY_ATTEMPTS：达到上限仍失败 → 放弃该条（标记失败、落库、
 * failedCount+1），继续下一条，而非终止整个任务。仅用户取消 / 撞登录墙才终止任务。
 * 等待期间分段（每 BACKOFF_POLL_INTERVAL_MS）检查 isCancelled，支持中途终止。
 */
const RETRY_BACKOFF_BASE_MS = 15 * 60 * 1000; // 首轮等待 15 分，之后递增
const MAX_RETRY_ATTEMPTS = 3;
const BACKOFF_POLL_INTERVAL_MS = 30_000;

/** 默认 sleep：真实定时器。测试可注入 spy 断言节奏而不真等。 */
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * §14.5–§14.15 清理编排器：execute(一次导航) → 按 receipt 映射四类 → 落库。
 *
 * 历史上是 inspect → decide → execute → 落库（每条开两次详情页）。现合并为单次
 * executeAction：驱动器内部一次导航完成等待渲染 → 读状态 → 点击 → 轮询复核，
 * 编排器据 receipt 区分 成功/跳过(wasCollected=false)/未知(not found)/失败(still collected)。
 * 结果持久化到 cleanup_plans/jobs/items/action_attempts 四张表，支持断点续跑
 *（findUnfavoritedSourceItemIds 认 actionStatus='unfavorited_verified' 或 'already_unfavorited'，二者皆为终态）。
 */
export async function runCleanupUnfavorite(
  opts: CleanupOrchestratorOptions,
): Promise<CleanupOrchestratorResult> {
  const { db, sourceAdapter, sourceInstanceId, migrationJobId, workspaceDir } = opts;
  const cleanup = sourceAdapter.cleanup;
  if (cleanup === undefined) {
    throw new Error('source adapter does not support cleanup');
  }

  // 1. 查候选：status='verified' 的条目，排除已成功取消收藏的（根治重跑）
  const alreadyDone = new CleanupItems(db).findUnfavoritedSourceItemIds(sourceInstanceId);
  // maxItems 默认上限 200（防风控）；用户显式传值则尊重（含更大值=自担风险）
  const limit = opts.maxItems ?? DEFAULT_CLEANUP_MAX_ITEMS;
  const allRows = db
    .prepare(
      `SELECT id, canonical_url, title, external_id, content_kind, fingerprint, discovered_at, source_position
       FROM source_items
       WHERE source_instance_id = ? AND status = 'verified' AND content_kind = 'article'
       ORDER BY source_position ASC`,
    )
    .all(sourceInstanceId) as Array<{
      id: number;
      canonical_url: string | null;
      title: string | null;
      external_id: string | null;
      content_kind: string;
      fingerprint: string;
      discovered_at: string;
      source_position: number | null;
    }>;
  const rows = (limit !== undefined ? allRows.slice(0, limit) : allRows)
    .filter((r) => !alreadyDone.has(r.id));

  if (rows.length === 0) {
    opts.onLog?.({ level: 'info', message: alreadyDone.size > 0 ? '没有需要清理的条目（均已成功取消收藏）' : '没有已迁移的条目可清理' });
    return { jobId: '', planId: '', successCount: 0, skippedCount: 0, failedCount: 0, unknownCount: 0, loginPauseCount: 0 };
  }

  const now = () => new Date().toISOString();
  const ts = now();
  const sleep = opts.sleepFn ?? defaultSleep;
  const intervalBase = opts.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

  // 2. 建 plan + job。§5-part2 调用 generateCleanupPlan 生成不可变计划并落地
  // reports/cleanup 下的 JSON/CSV/MD 审计报告（此前为死代码，编排器手写 planId）。
  const candidates = rows.map((r) => ({
    sourceItemId: r.id,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    ...(r.canonical_url ? { canonicalUrl: r.canonical_url } : {}),
    title: r.title ?? '(无标题)',
  }));
  const excluded = Array.from(alreadyDone).map((id) => ({
    sourceItemId: id,
    reason: 'already_unfavorited',
  }));
  const plan = generateCleanupPlan({
    reportsDir: `${workspaceDir}/reports`,
    sourceInstanceId,
    migrationJobId,
    action: 'unfavorite',
    candidates,
    excluded,
    databaseSnapshotVersion: Date.now(),
    // config_hash 反映本次清理的运行配置（节流参数 + 工作区），用于审计：
    // 配置变更（如用户调了 intervalMs/maxItems）会改变哈希，便于识别。
    configHash: sourceContentHash(
      JSON.stringify({ workspaceDir, intervalMs: intervalBase, maxItems: limit }),
    ),
  });
  const planId = plan.planId;
  const jobId = `cleanup-${Date.now()}`;
  new CleanupPlans(db).create({
    id: planId,
    sourceInstanceId,
    migrationJobId,
    action: 'unfavorite',
    planHash: plan.planHash,
    configHash: sourceContentHash(
      JSON.stringify({ workspaceDir, intervalMs: intervalBase, maxItems: limit }),
    ),
    candidateCount: rows.length,
    excludedCount: alreadyDone.size,
    status: 'created',
    createdAt: ts,
  });
  new CleanupJobs(db).create({
    id: jobId,
    planId,
    planHash: plan.planHash,
    action: 'unfavorite',
    status: 'running',
    candidateCount: rows.length,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  });

  opts.onLog?.({ level: 'info', message: `开始取消收藏，共 ${rows.length} 条${alreadyDone.size > 0 ? `（已排除 ${alreadyDone.size} 条成功项）` : ''}...` });

  const ctx: CleanupContext = { config: {}, workspaceDir };
  // 失败原因聚合（采样 + 汇总），保留既有可观测性
  const failReasons = new Map<string, number>();
  // §可观测性：未知原因聚合（采样 + 汇总）。unknown 分支此前只静默计数，"未知 N"成黑盒。
  const unknownReasons = new Map<string, number>();

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let unknownCount = 0;
  // §5/§14.12 登录/风控挑战受控中断计数（不再 15 分钟硬等）。对应 cleanup-report 的 loginPauseCount。
  let loginPauseCount = 0;
  // §缺陷2：processedCount 记录"实际已落库的条目数"，与 candidateCount(rows.length)
  // 区分。取消 / 重试终止时二者不等，必须如实落库，否则 GUI 进度与状态看板会错算。
  let processedCount = 0;
  // 是否因取消或重试仍失败而提前终止。决定最终 status：terminated → 'interrupted'。
  let terminated = false;
  // §5/§14.12 受控中断原因（login_required / challenge_required）。区分于普通 cancel/重试终止。
  let pauseReason: string | undefined;
  const itemsRepo = new CleanupItems(db);
  const attemptsRepo = new CleanupAttempts(db);

  for (let i = 0; i < rows.length; i++) {
    // 取消检查（GUI 终止按钮）：在处理新条目前退出，已处理的落库不丢
    if (opts.isCancelled?.()) {
      opts.onLog?.({ level: 'warn', message: `任务已终止：已处理 ${i}/${rows.length} 条` });
      terminated = true;
      break;
    }
    const row = rows[i]!;
    const titleShort = row.title?.substring(0, 50);
    opts.onProgress?.({
      phase: 'cleanup',
      current: i + 1,
      total: rows.length,
      ...(titleShort !== undefined ? { currentItem: titleShort } : {}),
    });

    const ref: SourceItemRef = {
      sourceInstanceId,
      contentKind: row.content_kind as SourceItemRef['contentKind'],
      discoveredAt: row.discovered_at || ts,
      fingerprint: row.fingerprint || '',
      sourceMetadata: {},
      ...(row.canonical_url ? { canonicalUrl: row.canonical_url, originalUrl: row.canonical_url } : {}),
      ...(row.title ? { title: row.title } : {}),
      ...(row.source_position !== null ? { sourcePosition: row.source_position } : {}),
      ...(row.external_id ? { externalId: row.external_id } : {}),
    };

    const actionStartedAt = now();
    // executeAction 内部一次导航完成：等待渲染 → 读状态 → 点击 → 轮询复核。
    // precheckStatus 由 receipt.wasCollected 反推，落库语义与原 inspect 路径一致。

    /**
     * 单次尝试的纯结果描述符（不含副作用：不修改计数器、不写日志、不触碰闭包状态）。
     *
     * 重构说明（M4）：此前 attemptOnce 直接修改 successCount/skippedCount/... 等闭包
     * 计数器，重试时需在外部 failedCount-- 回退——计数器在函数内外双向修改极易漏，
     * 且新增分支时回退会失配。现 attemptOnce 只产出结果，由 applyResult 统一应用计数，
     * 重试时用最新结果覆盖即可，无需回退。
     */
    interface AttemptOutcome {
      precheckStatus: PreActionState;
      actionStatus: string;
      lastErrorCode: string | null;
      lastErrorMessage: string | null;
      /** 计数类别：决定累加哪个计数器。 */
      countBucket: 'success' | 'skipped' | 'failed' | 'unknown' | 'none';
      /** 是否为"真正失败"（需触发等待重试）。 */
      hardFailed: boolean;
      /** §5/§14.12 检测到的特殊页面状态。 */
      detectedState?: 'login_required' | 'challenge_required' | 'content_unavailable';
      /** 失败/未知原因（用于 recordReason 聚合）。undefined 表示不聚合理由。 */
      reasonForLog?: { reason: string; bucket: 'fail' | 'unknown' };
    }

    /** 单次执行 + 四类映射，产出纯结果描述符。 */
    const attemptOnce = async (): Promise<AttemptOutcome> => {
      try {
        const receipt = await cleanup.executeAction(ref, 'unfavorite', ctx);

        // §5/§14.12 特殊页面检测：登录墙/风控挑战 → 受控中断（不硬等、不重试）
        if (receipt.detectedState === 'login_required' || receipt.detectedState === 'challenge_required') {
          return {
            precheckStatus: receipt.detectedState,
            actionStatus: receipt.detectedState,
            lastErrorCode: receipt.detectedState,
            lastErrorMessage: receipt.detectedState === 'login_required' ? '需要重新登录' : '触发风控验证',
            countBucket: 'none',
            hardFailed: false,
            detectedState: receipt.detectedState,
          };
        }
        // 内容不可用（删除等）→ 跳过，继续处理后续。action_status 同样落 already_unfavorited
        //（对取消收藏目标已是终态），以便重跑时被 findUnfavoritedSourceItemIds 排除。
        if (receipt.detectedState === 'content_unavailable') {
          return {
            precheckStatus: 'content_unavailable',
            actionStatus: ACTION_STATUS_ALREADY_UNFAVORITED,
            lastErrorCode: 'content_unavailable',
            lastErrorMessage: '内容不可用（已删除）',
            countBucket: 'skipped',
            hardFailed: false,
            detectedState: 'content_unavailable',
          };
        }

        const wasCollected = receipt.wasCollected;
        if (receipt.success && receipt.isCollected === false) {
          // 成功取消（含本来就未收藏）
          return {
            precheckStatus: wasCollected ? 'favorited' : 'not_favorited',
            actionStatus: wasCollected ? ACTION_STATUS_UNFAVORITED : ACTION_STATUS_ALREADY_UNFAVORITED,
            lastErrorCode: null,
            lastErrorMessage: null,
            countBucket: wasCollected ? 'success' : 'skipped',
            hardFailed: false,
          };
        }
        if (receipt.reason === 'collect button not found' || receipt.reason === 'no canonicalUrl') {
          // 状态判定失败（按钮未渲染/找不到）→ 未知。页面问题，重试无效，不触发等待。
          return {
            precheckStatus: wasCollected ? 'favorited' : 'not_favorited',
            actionStatus: 'state_unknown',
            lastErrorCode: receipt.reason,
            lastErrorMessage: receipt.reason,
            countBucket: 'unknown',
            hardFailed: false,
            reasonForLog: { reason: receipt.reason, bucket: 'unknown' },
          };
        }
        // 点击后仍收藏（含 still collected，风控信号）或其它失败 → 真正失败，触发等待重试
        const reason = receipt.reason ?? 'still collected after click';
        return {
          precheckStatus: wasCollected ? 'favorited' : 'not_favorited',
          actionStatus: 'verification_failed',
          lastErrorCode: reason,
          lastErrorMessage: reason,
          countBucket: 'failed',
          hardFailed: true,
          reasonForLog: { reason, bucket: 'fail' },
        };
      } catch (e) {
        const reason = `exception: ${e instanceof Error ? e.message : String(e)}`;
        return {
          precheckStatus: 'unknown',
          actionStatus: 'permanent_failed',
          lastErrorCode: reason,
          lastErrorMessage: reason,
          countBucket: 'failed',
          hardFailed: true,
          reasonForLog: { reason, bucket: 'fail' },
        };
      }
    };

    /** 当前条目的最新尝试结果（闭包变量，供 persistItem 读取最终态）。 */
    let latestOutcome: AttemptOutcome | undefined;
    // §I-F(2)：当前条目已执行的总尝试次数（首轮=1，每次重试 +1），供 persistItem 落 attemptNo。
    // R3-L4: 注意语义——耗尽 MAX_RETRY_ATTEMPTS(3) 的条目 attemptCount=4（1+3 重试），
    // 即 attemptCount = 首轮 + 重试次数，表示「总尝试次数」而非「重试次数」。
    let attemptCount = 0;

    /**
     * 记录一次尝试的可观测信号（失败/未知原因聚合 + 采样日志）并更新 latestOutcome。
     * 每次 attemptOnce 后调用——即便后续重试转成功，本次失败的日志仍保留（可观测性）。
     * 计数器不在此时累加：重试会改变最终归属，计数只在 persistItem 前按最终结果应用一次。
     */
    const observeAttempt = (outcome: AttemptOutcome): void => {
      attemptCount++;
      latestOutcome = outcome;
      if (outcome.reasonForLog !== undefined) {
        const map = outcome.reasonForLog.bucket === 'unknown' ? unknownReasons : failReasons;
        const label = outcome.reasonForLog.bucket === 'unknown' ? '未知' : '失败';
        recordReason(map, outcome.reasonForLog.reason, row.title, opts.onLog, label);
      }
    };

    /** 按【最终】结果累加一次计数器（每条仅调用一次，避免重试期间重复计数）。 */
    const applyFinalCount = (outcome: AttemptOutcome): void => {
      switch (outcome.countBucket) {
        case 'success': successCount++; break;
        case 'skipped': skippedCount++; break;
        case 'failed': failedCount++; break;
        case 'unknown': unknownCount++; break;
        // 'none'（登录墙/风控挑战）不计入四类计数
      }
    };

    // d. 落库（UPSERT 支持断点续跑）。抽成函数：重试终止分支也需先落库当前条再 break。
    // C3: 三步写（upsert → 回查 id → attempts.create）必须包在事务里，与迁移侧
    // commitTxn 一致。否则崩溃在 upsert 与 create 之间会产生有 cleanup_items 行但无
    // cleanup_action_attempts 审计行的状态。
    const persistItem = () => {
      processedCount++; // 每条落库计一次实际处理数（§缺陷2 对账准确性）
      const o = latestOutcome!;
      const actionFinishedAt = now();
      db.transaction(() => {
        itemsRepo.upsert({
          jobId,
          sourceItemId: row.id,
          precheckStatus: o.precheckStatus,
          preActionState: o.precheckStatus,
          actionStatus: o.actionStatus,
          postActionState: o.actionStatus,
          // M-2: 传入真实重试计数（首轮=1，每次重试+1），原恒为 1 与
          // cleanup_action_attempts 的真实计数矛盾。
          attemptCount,
          actionStartedAt,
          actionFinishedAt,
          verifiedAt: o.actionStatus === ACTION_STATUS_UNFAVORITED ? actionFinishedAt : null,
          lastErrorCode: o.lastErrorCode,
          lastErrorMessage: o.lastErrorMessage,
          createdAt: ts,
          updatedAt: actionFinishedAt,
        });
        // 审计日志（cleanup_item_id 由 UPSERT 产生，回查）
        // I7: 走 UNIQUE(job_id, source_item_id) 索引的精确查询，替代 listByJob 全表扫描 + find
        //（原 O(n²)，批量清理数百条时显著降低 DB 负载）。
        const itemRow = itemsRepo.findByJobAndSourceItem(jobId, row.id);
        if (itemRow !== undefined) {
          attemptsRepo.create({
            cleanupItemId: itemRow.id,
            // §I-F(2)：此前硬编码 attemptNo: 1，丢失了重试次数。改用本轮实际尝试次数
            //（首轮=1，每次重试 +1），使审计日志能反映重试历程。
            attemptNo: attemptCount,
            preActionState: o.precheckStatus,
            actionResult: o.actionStatus,
            postActionState: o.actionStatus,
            startedAt: actionStartedAt,
            finishedAt: actionFinishedAt,
            errorCode: o.lastErrorCode,
            errorMessage: o.lastErrorMessage,
            createdAt: actionFinishedAt,
          });
        }
      })();
    };

    const first = await attemptOnce();
    observeAttempt(first);

    // §5/§14.12 受控中断：检测到登录墙/风控挑战 → 立即落库当前条并终止任务，
    // 不走 15 分钟硬等（风控期重试无意义，且延长无登录状态的操作会加剧指纹风险）。
    // 提示用户重新登录后重跑（已处理的成功项由 cleanup_items 续跑排除）。
    if (first.detectedState === 'login_required' || first.detectedState === 'challenge_required') {
      loginPauseCount++;
      applyFinalCount(first); // countBucket='none'，实际不累加，但保持契约一致
      persistItem();
      terminated = true;
      pauseReason = first.detectedState;
      opts.onLog?.({
        level: 'warn',
        message:
          first.detectedState === 'login_required'
            ? '检测到登录失效，受控中断任务（请重新登录后重跑）'
            : '检测到风控验证挑战，受控中断任务（稍后重跑）',
      });
      break;
    }

    // §18.1 失败递增等待 + 有限重试：出现真正失败（风控等）时，原地等待冷却后重试当前条。
    // 等待时长逐轮递增（15→30→45 分钟），给累积风控信号更长冷却窗口；达 MAX_RETRY_ATTEMPTS
    // 仍失败则放弃该条（标记失败、继续下一条），而非终止整个任务——仅取消/登录墙才终止任务。
    if (first.hardFailed && !opts.isCancelled?.()) {
      let stillFailed = true;
      for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        if (opts.isCancelled?.()) break;
        const waitMs = RETRY_BACKOFF_BASE_MS * attempt; // 15/30/45 分钟
        opts.onLog?.({
          level: 'warn',
          message: `取消收藏失败（${latestOutcome!.lastErrorMessage}），原地等待 ${Math.round(waitMs / 60000)} 分钟后重试当前条（第 ${attempt}/${MAX_RETRY_ATTEMPTS} 次）...`,
        });
        // 分段等待，每段检查取消，支持中途终止。用固定段数（而非 Date.now 截止），
        // 使注入 sleepFn 的测试不依赖真实时间流逝即可跑完等待。
        const segments = Math.ceil(waitMs / BACKOFF_POLL_INTERVAL_MS);
        for (let s = 0; s < segments; s++) {
          if (opts.isCancelled?.()) break;
          await sleep(BACKOFF_POLL_INTERVAL_MS);
        }
        if (opts.isCancelled?.()) break;
        // 重试：observeAttempt 记录本次尝试的可观测信号；计数只在最终落库前应用一次，
        // 避免重试期间"先 failed++ 后 success++"的重复计数（M4 修复）。
        const retry = await attemptOnce();
        observeAttempt(retry);
        if (!retry.hardFailed) { stillFailed = false; break; }
        // 仍失败 → 进入下一轮更长等待
      }
      // 重试循环结束后仍处于失败态 → 放弃该条，继续下一条（不置 terminated，外层 for 继续推进）
      if (!opts.isCancelled?.() && stillFailed) {
        opts.onLog?.({
          level: 'error',
          message: `已达重试上限（${MAX_RETRY_ATTEMPTS} 次），放弃该条，继续下一条：已处理 ${i + 1}/${rows.length} 条`,
        });
      }
    }

    // d. 落库（UPSERT 支持断点续跑）。计数按最终结果累加一次（含重试转成功）。
    applyFinalCount(latestOutcome!);
    persistItem();

    // §18.1 条目间等待（防风控）：非最后一条、且未被取消时，按 intervalMs±40% 抖动等待。
    // 取消时跳过等待，让终止尽快生效。
    if (i < rows.length - 1 && !opts.isCancelled?.()) {
      await sleep(withJitter(intervalBase, ITEM_INTERVAL_JITTER));
    }
  }

  // 5. 收尾
  // §缺陷2：processedCount 如实记录实际落库条目数；status 按是否提前终止区分
  // interrupted / completed，避免取消后仍显示"已完成"误导 GUI 看板。
  const finishedAt = now();
  new CleanupJobs(db).updateCounts(jobId, {
    processedCount,
    successCount,
    skippedCount,
    failedCount,
    unknownCount,
  });
  const finalStatus = terminated ? 'interrupted' : 'completed';
  new CleanupJobs(db).updateStatus(jobId, { status: finalStatus, finishedAt, updatedAt: finishedAt });

  opts.onLog?.({
    level: failedCount > 0 ? 'warn' : 'info',
    message: `${terminated ? '任务已终止' : '清理完成'}：成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}${unknownCount > 0 ? `，未知 ${unknownCount}` : ''}`,
  });
  if (failedCount > 0 && failReasons.size > 0) {
    const summary = Array.from(failReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}×${count}`)
      .join('，');
    opts.onLog?.({ level: 'warn', message: `失败原因汇总：${summary}` });
  }
  // §可观测性：未知原因汇总。配合上方"未知 N"计数，不再让未知项成黑盒。
  if (unknownCount > 0 && unknownReasons.size > 0) {
    const summary = Array.from(unknownReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}×${count}`)
      .join('，');
    opts.onLog?.({ level: 'warn', message: `未知原因汇总：${summary}` });
  }

  const result: CleanupOrchestratorResult = {
    jobId,
    planId,
    successCount,
    skippedCount,
    failedCount,
    unknownCount,
    loginPauseCount,
  };
  if (pauseReason !== undefined) result.pauseReason = pauseReason;
  return result;
}

/**
 * 按 reason 聚合计数 + 前 REASON_SAMPLE_LIMIT 条采样打印。失败与未知共用：
 * label 决定日志前缀（"失败"/"未知"），语义更准确，避免把"按钮没渲染"误报为"失败"。
 */
function recordReason(
  reasons: Map<string, number>,
  reason: string,
  title: string | null,
  onLog?: (e: CleanupLogEntry) => void,
  label: '失败' | '未知' = '失败',
): void {
  const prev = reasons.get(reason) ?? 0;
  reasons.set(reason, prev + 1);
  if (prev < REASON_SAMPLE_LIMIT && onLog) {
    onLog({
      level: 'warn',
      message: `取消收藏${label}（${reason}）：${title?.substring(0, 50) ?? '(无标题)'}`,
    });
  }
}
