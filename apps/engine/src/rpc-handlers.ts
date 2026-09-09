/**
 * RPC 方法处理器——把 JSON-RPC 调用映射到 InkMigrate 核心 API。
 *
 * 每个 registerMethod 对应 protocol.ts 中的一个 RPC method。
 * 长任务（scan/migrate/cleanup）在执行过程中通过 sendNotification 推送进度。
 */
import {
  openDatabase,
  type DB,
  type TargetContext,
  type JobStatus,
  canResumeFrom,
  ensureInstance,
} from '@inkmigrate/core';
import { MigrationJobs } from '@inkmigrate/core';
import {
  createToutiaoSource,
  profilePath,
  profileExists,
  ensureProfileDir,
  ToutiaoBrowserSession,
  runLoginFlow,
  driveScanFavorites,
  runCleanupUnfavorite,
  type ToutiaoBrowserAdapterConfig,
} from '@inkmigrate/source-toutiao';
import { lastScanIssues } from '@inkmigrate/source-evernote';
import { resolveEvernoteSource, resolveSourceWiring, resolveTargetConfig } from '@inkmigrate/wiring';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  AuthLoginSchema,
  AuthStatusSchema,
  ScanStartSchema,
  ScanPreviewSchema,
  MigrateStartSchema,
  MigrateResumeSchema,
  MigrateResumableSchema,
  CleanupUnfavoriteSchema,
  StatusQuerySchema,
} from './schemas.js';
import {
  registerMethod,
  sendNotification,
  logToStderr,
} from './transport.js';
import { requestCancel, isCancelledFlag, beginTask, endTask, getActiveTask } from './cancellation.js';
import type {
  AuthLoginParams,
  AuthLoginResult,
  AuthStatusParams,
  AuthStatusResult,
  ScanStartParams,
  ScanStartResult,
  ScanPreviewParams,
  ScanPreviewResult,
  MigrateStartParams,
  MigrateResumeParams,
  MigrateResumableParams,
  MigrateResumableResult,
  MigrateResult,
  CleanupUnfavoriteParams,
  CleanupResult,
  StatusQueryParams,
  StatusQueryResult,
} from './protocol.js';

/**
 * 展开路径中的 ~ 为用户主目录。
 * 兼容 POSIX（~/）与 Windows（~\）分隔符。注意 Windows 上 ~ 并非 shell 默认
 * 展开形式，但 GUI/用户可能手填；homedir() 在各平台都返回正确主目录。
 */
function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p.startsWith('~\\')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/** 对 params 对象中的路径字段做 ~ 展开。 */
function expandPaths<T>(
  params: T,
  fields: readonly string[],
): T {
  const result = { ...params } as Record<string, unknown>;
  for (const f of fields) {
    const v = result[f];
    if (typeof v === 'string') {
      result[f] = expandHome(v);
    }
  }
  return result as T;
}

/**
 * 实例 ID / Job ID 合法字符集：字母、数字、下划线、连字符，且非空。
 * RPC 是信任边界（GUI 表单校验不可信赖），必须显式校验，否则空串或含
 * 路径分隔符的值会污染后续路径/锁名/JobId 构造。
 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * adapter.close() 超时泄漏计数。sidecar 是长驻进程，每次超时都可能留下孤儿 Chromium。
 * 达到阈值强制退出（Tauri 会重启 sidecar），避免内存/FD 耗尽。
 */
let adapterLeakCount = 0;
const ADAPTER_LEAK_EXIT_THRESHOLD = 3;

/** 校验实例 ID / Job ID：非空且仅含合法字符。失败抛错。 */
function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} 不能为空`);
  }
  if (!ID_RE.test(value)) {
    throw new Error(`${field} 含非法字符（仅允许字母、数字、下划线、连字符）：${value}`);
  }
}

/** 校验 stateDir 非空字符串（路径展开后）。 */
function requireStateDir(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('stateDir 不能为空');
  }
}

/** 校验 vaultPath 非空字符串。 */
function requireVaultPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('vaultPath 不能为空');
  }
}

/**
 * I25: 校验正整数毫秒值（如 intervalMs）。GUI 输入框键入非数字时 parseInt 得 NaN，
 * setTimeout(NaN) 等同 0 → 以最快速率轰炸头条接口 → 触发风控/封号。
 * 信任边界必须校验：非有限数或 ≤0 直接拒绝。
 */
function requirePositiveMs(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} 必须是正数（毫秒），收到：${String(value)}`);
  }
}

/** I25: 校验正整数（如 maxItems），undefined 时跳过（可选参数）。 */
function requirePositiveIntIfDefined(value: unknown, field: string): asserts value is number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${field} 必须是正整数，收到：${String(value)}`);
  }
}

/** 打开 stateDir 下的状态库（统一 DB 文件名，所有 RPC 共用）。 */
function openStateDb(stateDir: string): DB {
  return openDatabase({ path: join(stateDir, 'inkmigrate.sqlite') });
}

/** 要求登录 Profile 已存在（toutiao 源的扫描/迁移/清理共同前置条件）。 */
function requireProfileExists(stateDir: string, source: string): void {
  const profileDir = profilePath(stateDir, source);
  if (!profileExists(stateDir, source)) {
    throw new Error(`Profile 不存在：${profileDir}，请先 auth.login`);
  }
}

/** 注册所有 RPC 方法。 */
export function registerAllHandlers(): void {
  // N7: 每个方法传入 zod schema，在 transport dispatch 前统一校验 params（信任边界）
  registerMethod('auth.login', (p) => handleAuthLogin(expandPaths(p as unknown as AuthLoginParams, ['stateDir'])), AuthLoginSchema);
  registerMethod('auth.status', (p) => handleAuthStatus(expandPaths(p as unknown as AuthStatusParams, ['stateDir'])), AuthStatusSchema);
  registerMethod('auth.clear', (p) => handleAuthClear(expandPaths(p as unknown as AuthStatusParams, ['stateDir'])), AuthStatusSchema);
  registerMethod('scan.start', (p) => handleScanStart(expandPaths(p as unknown as ScanStartParams, ['stateDir'])), ScanStartSchema);
  registerMethod('scan.preview', (p) => handleScanPreview(expandPaths(p as unknown as ScanPreviewParams, ['stateDir', 'configPath'])), ScanPreviewSchema);
  registerMethod('migrate.start', (p) => handleMigrateStart(expandPaths(p as unknown as MigrateStartParams, ['stateDir', 'vaultPath'])), MigrateStartSchema);
  registerMethod('migrate.resume', (p) => handleMigrateResume(expandPaths(p as unknown as MigrateResumeParams, ['stateDir', 'vaultPath'])), MigrateResumeSchema);
  registerMethod('migrate.resumable', (p) => handleMigrateResumable(expandPaths(p as unknown as MigrateResumableParams, ['stateDir'])), MigrateResumableSchema);
  registerMethod('cleanup.unfavorite', (p) => handleCleanupUnfavorite(expandPaths(p as unknown as CleanupUnfavoriteParams, ['stateDir'])), CleanupUnfavoriteSchema);
  registerMethod('status.query', (p) => handleStatusQuery(expandPaths(p as unknown as StatusQueryParams, ['stateDir'])), StatusQuerySchema);
  // 终止当前长任务：设置进程级 cancel flag，循环在下一次迭代边界退出。
  // job.cancel 取代此前语义重复的 cancel.cancel；params 可选 job id（当前实现为全局取消）
  registerMethod('job.cancel', async () => {
    requestCancel();
    sendNotification('log', { level: 'warn', message: '收到终止请求，正在停止当前任务...' });
    return { cancelling: true };
  });
}

// ─── auth ───

async function handleAuthLogin(params: AuthLoginParams | undefined): Promise<AuthLoginResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  const profileDir = ensureProfileDir(params.stateDir, params.source);
  const session = new ToutiaoBrowserSession({ profileDir, headless: false });
  try {
    await session.launch();
    // 通知 GUI：浏览器已打开
    sendNotification('log', {
      level: 'info',
      message: '浏览器已打开，请在浏览器窗口中扫码登录',
    });
    sendNotification('progress', {
      phase: 'login',
      current: 0,
      total: 0,
    });
    // 心跳：每 10 秒推送"等待登录中"，让用户知道没卡死
    let waitSeconds = 0;
    const heartbeat = setInterval(() => {
      waitSeconds += 10;
      sendNotification('progress', {
        phase: 'login',
        current: waitSeconds,
        total: (params.timeoutMs ?? 300_000) / 1000,
        currentItem: '等待扫码登录...',
      });
    }, 10_000);

    try {
    const result = await runLoginFlow({
      session,
      loginTimeoutMs: params.timeoutMs ?? 300_000,
    });
    // 登录结束（成功或超时）立即推完成进度，消除心跳残留的"登录中 X/300"视觉错位。
    sendNotification('progress', {
      phase: 'login',
      current: 1,
      total: 1,
      ...(result.state === 'logged-in' ? { currentItem: '登录成功' } : { currentItem: '登录未完成' }),
    });
    sendNotification('log', {
      level: result.state === 'logged-in' ? 'info' : 'warn',
      message: `登录结果：${result.state}${result.favoritesUrl ? '，已获取收藏页 URL' : ''}`,
    });
    return {
      state: result.state,
      ...(result.favoritesUrl !== undefined ? { favoritesUrl: result.favoritesUrl } : {}),
    };
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await session.close();
  }
}

async function handleAuthStatus(params: AuthStatusParams | undefined): Promise<AuthStatusResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  const pPath = profilePath(params.stateDir, params.source);
  return {
    profileExists: profileExists(params.stateDir, params.source),
    profilePath: pPath,
  };
}

async function handleAuthClear(params: AuthStatusParams | undefined): Promise<{ cleared: boolean }> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  const pPath = profilePath(params.stateDir, params.source);
  if (!profileExists(params.stateDir, params.source)) {
    return { cleared: false };
  }
  rmSync(pPath, { recursive: true, force: true });
  return { cleared: true };
}

// ─── scan ───

/**
 * §15 Evernote 文件源预览扫描：条目数 + Stack/笔记本分布 + 问题清单。
 * 不写库、不启动浏览器、不占用长任务槽位（纯读，秒级完成）。
 */
async function handleScanPreview(params: ScanPreviewParams | undefined): Promise<ScanPreviewResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  const wiring = resolveEvernoteSource({
    config: params.configPath,
    sourceId: params.source,
  });
  if (wiring === undefined) {
    throw new Error(
      `配置 ${params.configPath} 中未找到启用的 evernote 来源：${params.source}（来源不存在、未启用或 adapter 不是 evernote）`,
    );
  }
  const byNotebook: Record<string, number> = {};
  let count = 0;
  let issues: string[] = [];
  try {
    for await (const ref of wiring.adapter.scan({ config: {}, workspaceDir: params.stateDir })) {
      count += 1;
      const meta = ref.sourceMetadata as { enex?: { notebook?: string | undefined; stack?: string | undefined } };
      const key = [meta.enex?.stack, meta.enex?.notebook].filter(Boolean).join('/') || '(未知)';
      byNotebook[key] = (byNotebook[key] ?? 0) + 1;
    }
    issues = [...lastScanIssues(wiring.adapter)];
  } finally {
    // scan 中途抛出（文件损坏/IO 错误）也必须关闭 adapter，长驻 sidecar 不容忍资源泄漏
    await wiring.adapter.close();
  }
  return { sourceInstanceId: params.source, uniqueItems: count, byNotebook, issues, skipped: [] };
}

async function handleScanStart(params: ScanStartParams | undefined): Promise<ScanStartResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  if (typeof params.favoritesUrl !== 'string' || params.favoritesUrl.length === 0) {
    throw new Error('favoritesUrl 不能为空');
  }
  // M5: scan.start 路径补 maxItems 校验，与 migrate.start/cleanup.unfavorite 一致，
  // 拒绝 GUI parseInt 产生的 NaN（I25：非法数值不应直达抓取层）。
  requirePositiveIntIfDefined(params.maxItems, 'maxItems');
  requireProfileExists(params.stateDir, params.source);

  const session = new ToutiaoBrowserSession({
    profileDir: profilePath(params.stateDir, params.source),
    // 默认有头：头条对 headless 浏览器做反爬检测，会返回空壳页面（实测 headless 扫出 0 条，
    // 有头扫出全部）。仅当显式传 headless:true 时才用无头。
    headless: params.headless ?? false,
  });
  // C10: 占用活跃任务槽位（拒绝并发长任务，避免 resetCancel 互踩取消请求）。
  // 紧贴 try：占槽与 try 之间插入任何可能抛出的语句都会让槽位泄漏。
  beginTask('scan');
  try {
    await session.launch();
    const page = await session.newPage();

    // 通知 GUI：开始扫描
    sendNotification('log', { level: 'info', message: '正在打开收藏页...' });
    sendNotification('progress', { phase: 'scanning', current: 0, total: 0 });

    const { refs, scanResult } = await driveScanFavorites({
      page,
      favoritesUrl: params.favoritesUrl,
      baseUrl: 'https://www.toutiao.com/',
      sourceInstanceId: params.source,
      isCancelled: isCancelledFlag,
      ...(params.maxItems !== undefined ? { maxItems: params.maxItems } : {}),
      onProgress: (info) => {
        sendNotification('progress', {
          phase: 'scanning',
          current: info.found,
          total: 0,
          currentItem: `第 ${info.scrollRound} 轮滚动`,
        });
      },
    });

    await page.close();

    // 扫描完成日志：区分终止/空结果/正常三种情况（盲区二+四）
    if (scanResult.terminationReason === 'cancelled') {
      sendNotification('log', { level: 'warn', message: `扫描已终止，共扫到 ${scanResult.uniqueItems} 条` });
    } else if (scanResult.uniqueItems === 0) {
      // 0 条：提示可能原因（反爬/未登录/URL 失效），而非静默"完成 0 条"
      sendNotification('log', {
        level: 'warn',
        message: `扫描完成：0 条。可能原因：①收藏夹确实为空 ②头条反爬(headless 会返回空壳，需有头模式) ③登录态失效 ④收藏页 URL(token)已过期。请检查浏览器窗口是否正常打开收藏页。`,
      });
    } else {
      sendNotification('log', {
        level: 'info',
        message: `扫描完成：${scanResult.uniqueItems} 条`,
      });
    }

    return {
      uniqueItems: scanResult.uniqueItems,
      terminationReason: scanResult.terminationReason,
      items: refs.map((r) => ({
        ...(r.externalId !== undefined ? { externalId: r.externalId } : {}),
        canonicalUrl: r.canonicalUrl ?? '',
        title: r.title ?? '',
        contentKind: r.contentKind,
      })),
    };
  } finally {
    await session.close();
    endTask('scan'); // C10: 释放活跃任务槽位
  }
}

// ─── migrate ───

async function handleMigrateStart(params: MigrateStartParams | undefined): Promise<MigrateResult> {
  if (params === undefined) throw new Error('missing params');
  return runMigrateJob(params, false);
}

async function handleMigrateResume(params: MigrateResumeParams | undefined): Promise<MigrateResult> {
  if (params === undefined) throw new Error('missing params');
  return runMigrateJob(params, true);
}

/**
 * 查询某 source 下最近一个可续跑的迁移 Job，供前端一键续跑，免去手填 Job ID。
 *
 * 判定可续跑：
 *  - 显式终态 interrupted / paused（§11.1 resume 来源）；
 *  - 兜底：status='running' 但 updated_at 距今超过 STALE_RUNNING_MS，
 *    视为进程崩溃后未清理的悬挂 Job（kill -9 / 断电不会写 interrupted）。
 * 只看该 source 的最近 Job：续跑场景下用户关心的就是"上一次没跑完的那个"。
 */
async function handleMigrateResumable(
  params: MigrateResumableParams | undefined,
): Promise<MigrateResumableResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  const db: DB = openStateDb(params.stateDir);
  try {
    const job = resolveResumableJob(db, params.source);
    if (job === undefined) return { job: null };

    // 已完成 / 已 verified 的条目计数：续跑会跳过这些
    const total = (
      db
        .prepare('SELECT COUNT(*) AS c FROM source_items WHERE source_instance_id = ?')
        .get(params.source) as { c: number }
    ).c;
    const verified = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM source_items WHERE source_instance_id = ? AND status = 'verified'",
        )
        .get(params.source) as { c: number }
    ).c;

    return {
      job: job.id,
      // 与 handleStatusQuery 同理：DB 的 CHECK 约束保证 status ∈ JobStatus 合法值，
      // 编译期 DB 读出为 string 需窄化。
      status: job.status as JobStatus,
      total,
      verified,
      targetInstanceId: job.targetInstanceId,
    };
  } finally {
    db.close();
  }
}

/** 进程崩溃后未写 interrupted 的 running Job 视为可续跑的时长阈值（毫秒）。 */
const STALE_RUNNING_MS = 5 * 60 * 1000;

/** 找该 source 下最近一个可续跑 Job，没有则 undefined。 */
function resolveResumableJob(
  db: DB,
  sourceInstanceId: string,
): { id: string; status: string; targetInstanceId: string } | undefined {
  const rows = db
    .prepare(
      `SELECT id, status, target_instance_id AS targetInstanceId, updated_at AS updatedAt
       FROM migration_jobs
       WHERE source_instance_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .all(sourceInstanceId) as Array<{
      id: string;
      status: string;
      targetInstanceId: string;
      updatedAt: string;
    }>;
  if (rows.length === 0) return undefined;
  const job = rows[0]!;
  if (canResumeFrom(job.status as JobStatus)) return job;
  // 兜底：running 但卡住（进程已死），仍允许续跑
  if (job.status === 'running') {
    const age = Date.now() - new Date(job.updatedAt).getTime();
    // 本进程正有 migrate 在跑时，该 running Job 很可能就是它（大附件/限流退避下
    // updated_at 可能超过 5 分钟未更新）——此时不得判定可续跑，否则同源并发写库。
    if (age > STALE_RUNNING_MS && getActiveTask() !== 'migrate') return job;
  }
  return undefined;
}

async function runMigrateJob(
  params: MigrateStartParams | MigrateResumeParams,
  isResume: boolean,
): Promise<MigrateResult> {
  // M2 输入校验（信任边界）：在打开 DB 前先拒绝非法参数
  requireStateDir(params.stateDir);
  requireVaultPath(params.vaultPath);
  if (isResume) {
    requireId((params as MigrateResumeParams).job, 'job');
  } else {
    requireId((params as MigrateStartParams).source, 'source');
    requireId((params as MigrateStartParams).target, 'target');
  }

  // 动态导入避免顶层依赖循环
  const { runMigrationJob } = await import('@inkmigrate/core');

  mkdirSync(params.stateDir, { recursive: true });
  // C10: 先占活跃任务槽位再开库——若已有并发长任务，beginTask 抛出时不会泄漏
  // 已打开的 SQLite 连接（原实现 openDatabase 在 beginTask 之前，长驻 sidecar 会累积句柄）。
  beginTask('migrate');
  let db: DB | undefined;
  try {
    // 每个 RPC 各自 open/close 连接：better-sqlite3 在 WAL 模式下连接打开很轻量，
    // 且长任务（migrate）与瞬时查询（status）用各自连接读到的都是已提交快照（WAL 隔离），
    // 不会读到半提交状态。未做进程级连接复用——多 stateDir 场景下连接生命周期管理复杂，
    // 易引入悬挂连接；当前访问模式下重开的代价可忽略，故优先正确性与简单性。
    db = openStateDb(params.stateDir);
    let sourceInstanceId: string;
    let targetInstanceId: string;

    if (isResume) {
      const resumeParams = params as MigrateResumeParams;
      const oldJob = new MigrationJobs(db).get(resumeParams.job);
      if (!oldJob) {
        throw new Error(`Job 不存在：${resumeParams.job}`);
      }
      sourceInstanceId = oldJob.sourceInstanceId;
      targetInstanceId = oldJob.targetInstanceId;
    } else {
      const startParams = params as MigrateStartParams;
      sourceInstanceId = startParams.source;
      targetInstanceId = startParams.target;
    }
    // M5: maxItems/intervalMs 校验对 start 和 resume 两路径统一生效（原仅 start 校验，
    // resume 路径漏校验，GUI parseInt 产生的 NaN 可直达抓取层，I25 封号风险）。
    if ('intervalMs' in params && params.intervalMs !== undefined) {
      requirePositiveMs(params.intervalMs, 'intervalMs');
    }
    requirePositiveIntIfDefined(params.maxItems, 'maxItems');

    // 构造 source adapter（profileDir 在 ensureInstance 之前计算，用于 config_hash）
    // §10.2 配置驱动分派（与 CLI 同一接线，见 @inkmigrate/wiring）：
    // configPath 命中 adapter: evernote → 文件源（无需 Profile）；否则 toutiao。
    const wiring =
      params.configPath !== undefined
        ? resolveSourceWiring({
            config: params.configPath,
            sourceId: sourceInstanceId,
            stateDir: params.stateDir,
          })
        : undefined;

    if (wiring === undefined || wiring.kind === 'toutiao') {
      requireProfileExists(params.stateDir, sourceInstanceId);
    }

    // 确保实例存在（FK 约束要求）。config_hash 反映各实例配置指纹。
    const sourceConfig: Record<string, unknown> =
      wiring !== undefined
        ? wiring.instanceConfig
        : { sourceInstanceId, profileDir: profilePath(params.stateDir, sourceInstanceId), headless: false };
    // R4-M7: targetConfig 用与 CLI 一致的完整 7 键（原只传 vaultPath，hash 与 CLI 不同
    // → 每次跨工具运行触发虚假 UPDATE）。configPath 存在时经 yaml target（schema 默认值）。
    const targetConfig: Record<string, unknown> =
      params.configPath !== undefined
        ? resolveTargetConfig(params.configPath, targetInstanceId, params.vaultPath)
        : {
            vaultPath: params.vaultPath,
            importSubdir: '',
            attachmentsSubdir: 'Attachments',
            linkStyle: 'wikilink',
            overwritePolicy: 'preserve',
            collectionMapping: { toTags: false, toFolders: false },
            maxFilenameLength: 100,
          };
    // 构造 source adapter：wiring 命中（evernote/toutiao）用其适配器；
    // 无 configPath 时维持 toutiao 浏览器（adapterConfig 用已计算的 profileDir）。
    // 提前到 ensureInstance 之前：实例审计列（adapter_version 等）要取适配器真实值。
    const startParams = params as MigrateStartParams;
    let sourceAdapter;
    if (wiring !== undefined) {
      sourceAdapter = wiring.adapter;
    } else {
      const adapterConfig: ToutiaoBrowserAdapterConfig = {
        sourceInstanceId,
        profileDir: profilePath(params.stateDir, sourceInstanceId),
        // 有头模式：头条反爬会拦截 headless（返回空壳），迁移必须用有头
        headless: false,
      };
      if (startParams.favoritesUrl !== undefined) {
        adapterConfig.favoritesUrl = startParams.favoritesUrl;
      }
      if (startParams.maxItems !== undefined) {
        adapterConfig.maxScanItems = startParams.maxItems;
      }
      sourceAdapter = createToutiaoSource(adapterConfig);
    }

    // 构造 target。intervalMs 不能放 targetConfig（ObsidianTargetConfigSchema strict
    // 会拒绝），现作为 runMigrationJob 的一级字段传入（类型化契约，不再塞 config bag）。
    const targetAdapter = createObsidianTarget();

    ensureInstance(db, sourceInstanceId, wiring?.kind ?? 'toutiao', 'source', sourceConfig, {
      adapterVersion: sourceAdapter.version,
      adapterApiVersion: sourceAdapter.adapterApiVersion,
    });
    ensureInstance(db, targetInstanceId, 'obsidian', 'target', targetConfig, {
      adapterVersion: targetAdapter.version,
      adapterApiVersion: targetAdapter.adapterApiVersion,
    });

    sendNotification('log', { level: 'info', message: isResume ? `续跑 Job ${(params as MigrateResumeParams).job}...` : '正在创建迁移任务...' });

    // 创建新 Job。毫秒时间戳不保证唯一（同一毫秒两次调用/时钟回拨会撞主键——
    // sidecar 与 CLI 共享同一 DB），追加随机后缀保证碰撞免疫。
    const jobId = `mig-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    new MigrationJobs(db).create({
      id: jobId,
      sourceInstanceId,
      targetInstanceId,
      status: 'created',
      currentStage: 'preflight',
      createdAt: now,
      updatedAt: now,
    });

    const targetContext: TargetContext = {
      config: {},
      workspaceDir: params.stateDir,
      vaultPath: params.vaultPath,
      targetConfig: targetConfig,
    };

    // 进度通过 onProgress 回调实时推送（见下方 runMigrationJob 调用）

    const result = await runMigrationJob({
      db,
      jobId,
      sourceAdapter,
      targetAdapter,
      sourceInstanceId,
      targetInstanceId,
      targetContext,
      workspaceDir: params.stateDir,
      reportsDir: join(params.stateDir, 'reports'),
      // intervalMs 作为一级字段传入（§18.1 类型化速率控制契约）
      ...(startParams.intervalMs !== undefined ? { intervalMs: startParams.intervalMs } : {}),
      isCancelled: isCancelledFlag,
      onProgress: (progress) => {
        // 把 job-runner 进度转发为 JSON-RPC notification
        sendNotification('progress', {
          jobId: progress.jobId,
          phase: progress.phase,
          current: progress.current,
          total: progress.total,
          ...(progress.currentItem !== undefined ? { currentItem: progress.currentItem } : {}),
          ...(progress.stage !== undefined ? { stage: progress.stage } : {}),
          ...(progress.counts !== undefined ? { counts: progress.counts } : {}),
        });
      },
      onLog: (level, message) => sendNotification('log', { level, message }),
    });

    // 完成时的状态日志
    const statusMsgs: Record<string, string> = {
      completed: `迁移完成：${result.scanCount} 条，对账${result.reconciliationOk ? '通过' : '失败'}`,
      failed: `迁移失败：${result.reconciliationReason ?? '对账失败'}`,
      interrupted: '迁移已中断，可用 resume 续跑',
      paused: '已被限流暂停（429），请稍后用 resume 续跑',
    };
    sendNotification('log', {
      level: result.status === 'completed' ? 'info' : 'warn',
      message: statusMsgs[result.status] ?? result.status,
    });

    return {
      status: result.status,
      scanCount: result.scanCount,
      reconciliationOk: result.reconciliationOk,
      ...(result.reconciliationReason !== undefined
        ? { reconciliationReason: result.reconciliationReason }
        : {}),
      jobId,
    };
  } finally {
    db?.close();
    endTask('migrate'); // C10: 释放活跃任务槽位
  }
}

// ─── cleanup ───

async function handleCleanupUnfavorite(
  params: CleanupUnfavoriteParams | undefined,
): Promise<CleanupResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.source, 'source');
  // M6: 取消收藏是不可逆的源端写操作，要求显式确认令牌（与 CLI 的 UNFAVORITE 短语
  // 或 --force 对齐）。缺令牌即拒，防止 sidecar 被非信任调用方触发破坏性操作。
  if (params.confirmed !== true) {
    throw new Error('取消收藏是破坏性操作，需显式确认：传 confirmed:true（GUI 用户确认后设置）');
  }
  // I25: 信任边界校验速率/上限数值
  if (params.intervalMs !== undefined) requirePositiveMs(params.intervalMs, 'intervalMs');
  requirePositiveIntIfDefined(params.maxItems, 'maxItems');
  // C10: 先占活跃任务槽位再开库——占槽失败（并发长任务）抛出时不泄漏已打开的 DB 连接
  beginTask('cleanup');
  let db: DB | undefined;
  try {
    db = openStateDb(params.stateDir);
    const profileDir = profilePath(params.stateDir, params.source);
    if (!profileExists(params.stateDir, params.source)) {
      throw new Error(`Profile 不存在：${profileDir}，请先 auth.login`);
    }

    // cleanup_plans.migration_job_id 是 NOT NULL FK，需关联一次迁移任务
    const migrationJobId = resolveLatestMigrationJobId(db, params.source);

    const adapter = createToutiaoSource({
      sourceInstanceId: params.source,
      profileDir,
      // 有头模式：头条反爬会拦截 headless（收藏按钮状态返回异常），清理必须用有头
      headless: false,
    });

    try {
      // prepare 在 try 内：部分启动后抛出（导航/超时）同样要经 closeAdapterSafely
      // 兜底关闭，否则 Chromium 进程泄漏。
      await adapter.prepare({ config: {}, workspaceDir: params.stateDir });
      const result = await runCleanupUnfavorite({
        db,
        sourceAdapter: adapter,
        sourceInstanceId: params.source,
        migrationJobId,
        workspaceDir: params.stateDir,
        isCancelled: isCancelledFlag,
        ...(params.maxItems !== undefined ? { maxItems: params.maxItems } : {}),
        ...(params.intervalMs !== undefined ? { intervalMs: params.intervalMs } : {}),
        onProgress: (p) => sendNotification('progress', {
          phase: 'cleanup',
          current: p.current,
          total: p.total,
          ...(p.currentItem !== undefined ? { currentItem: p.currentItem } : {}),
        }),
        onLog: (entry) => sendNotification('log', { level: entry.level, message: entry.message }),
      });
      return {
        successCount: result.successCount,
        skipCount: result.skippedCount,
        failCount: result.failedCount,
        unknownCount: result.unknownCount,
        // §5/§14.12 登录墙/风控挑战受控中断信息——GUI 据此提示用户重新登录，
        // 此前被丢弃导致用户只看到"失败 N 条"不知是风控。
        loginPauseCount: result.loginPauseCount,
        // orchestrator 只会赋 'login_required' | 'challenge_required'（接口声明仍为
        // string），按协议类型窄化
        ...(result.pauseReason !== undefined
          ? { pauseReason: result.pauseReason as NonNullable<CleanupResult['pauseReason']> }
          : {}),
        ...(result.jobId ? { jobId: result.jobId } : {}),
      };
    } finally {
      // 双保险：BrowserSession.close() 已有 15s 超时，但万一被绕过/失效，
      // adapter.close() 仍可能永久挂起（Playwright BrowserContext.close 无超时）。
      // cleanup 结果此时已求值待返回，绝不能被关浏览器拖死——给上限，超时则记日志放弃。
      await closeAdapterSafely(adapter);
    }
  } finally {
    db?.close();
    endTask('cleanup'); // C10: 释放活跃任务槽位
  }
}

/**
 * 带超时关闭源适配器：cleanup 的 RPC 结果已在 return 表达式里求值，
 * 关浏览器（Playwright BrowserContext.close 无超时）若卡死会吞掉返回值，
 * 导致前端 busy 永不复位。此处设上限，超时则记日志放弃，保证 RPC 必返回。
 */
async function closeAdapterSafely(adapter: { close(): Promise<void> }): Promise<void> {
  const CLOSE_TIMEOUT_MS = 20_000; // 略大于 BrowserSession 内层的 15s，给第一层先兜
  let timed = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timed = true;
      resolve();
    }, CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([adapter.close(), timer]);
    if (timed) {
      // L13: 超时后 adapter.close()（losing 分支）仍在后台运行，可能泄漏 Chromium 进程。
      // Node 无法真正取消 promise，此处记录告警 + 累计泄漏计数。达到阈值时强制退出
      // sidecar（让 Tauri 重启），避免长驻进程累积僵尸 Chromium 耗尽内存/FD。
      adapterLeakCount++;
      logToStderr(
        'warn',
        `adapter.close() 超时，后台 close 仍在运行，可能泄漏浏览器进程（累计泄漏 ${adapterLeakCount}/${ADAPTER_LEAK_EXIT_THRESHOLD}）`,
      );
      if (adapterLeakCount >= ADAPTER_LEAK_EXIT_THRESHOLD) {
        logToStderr('error', `adapter 泄漏达阈值（${adapterLeakCount}），强制退出 sidecar 以释放资源`);
        process.exit(1);
      }
    }
  } catch (e) {
    logToStderr('warn', `adapter.close() 异常（已忽略）：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // close() 先完成时清掉定时器：游离 timer 会挂住事件循环最长 20s（延迟进程退出/卡测试）
    clearTimeout(timeoutId);
  }
}

/** 解析 source_instance 关联的最新迁移任务 ID（满足 cleanup_plans FK 约束）。 */
function resolveLatestMigrationJobId(db: DB, sourceInstanceId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM migration_jobs WHERE source_instance_id=? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceInstanceId) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error('没有可关联的迁移任务，请先完成迁移再清理');
  }
  return row.id;
}

// ─── status ───

async function handleStatusQuery(
  params: StatusQueryParams | undefined,
): Promise<StatusQueryResult> {
  if (params === undefined) throw new Error('missing params');
  requireStateDir(params.stateDir);
  requireId(params.job, 'job');
  const db: DB = openStateDb(params.stateDir);
  try {
    const job = new MigrationJobs(db).get(params.job);
    if (job === undefined) {
      throw new Error(`Job 不存在：${params.job}`);
    }
    return {
      // DB 的 source_items/migration_jobs CHECK 约束保证 status ∈ JobStatus 合法值，
      // 此处断言安全（运行时已被 schema 约束，编译期 DB 读出为 string 需窄化）。
      status: job.status as 'created' | 'running' | 'paused' | 'interrupted' | 'completed' | 'failed',
      currentStage: job.currentStage,
      scanCount: job.scanCount ?? 0,
      verifiedCount: job.verifiedCount ?? 0,
      degradedCount: job.degradedCount ?? 0,
      failedCount: job.failedCount ?? 0,
      conflictCount: job.conflictCount ?? 0,
      skippedCount: job.skippedCount ?? 0,
    };
  } finally {
    db.close();
  }
}
