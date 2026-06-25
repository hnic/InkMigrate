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
  type ToutiaoBrowserAdapterConfig,
} from '@inkmigrate/source-toutiao';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 展开路径中的 ~ 为用户主目录。 */
function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/** 确保实例记录存在（FK 约束要求）。只插入对应角色的表。 */
function ensureInstance(db: DB, id: string, adapterKind: string, role: 'source' | 'target'): void {
  const table = role === 'source' ? 'source_instances' : 'target_instances';
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  if (!existing) {
    const nowTs = new Date().toISOString();
    db.prepare(
      `INSERT INTO ${table}(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(id, adapterKind, '1.0.0', '1.0.0', 'h', nowTs, nowTs);
  }
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
import {
  registerMethod,
  sendNotification,
  logToStderr,
} from './transport.js';
import type {
  AuthLoginParams,
  AuthLoginResult,
  AuthStatusParams,
  AuthStatusResult,
  ScanStartParams,
  ScanStartResult,
  MigrateStartParams,
  MigrateResumeParams,
  MigrateResult,
  CleanupUnfavoriteParams,
  CleanupResult,
  StatusQueryParams,
  StatusQueryResult,
} from './protocol.js';

/** 注册所有 RPC 方法。 */
export function registerAllHandlers(): void {
  registerMethod('auth.login', (p) => handleAuthLogin(expandPaths(p as unknown as AuthLoginParams, ['stateDir'])));
  registerMethod('auth.status', (p) => handleAuthStatus(expandPaths(p as unknown as AuthStatusParams, ['stateDir'])));
  registerMethod('auth.clear', (p) => handleAuthClear(expandPaths(p as unknown as AuthStatusParams, ['stateDir'])));
  registerMethod('scan.start', (p) => handleScanStart(expandPaths(p as unknown as ScanStartParams, ['stateDir'])));
  registerMethod('migrate.start', (p) => handleMigrateStart(expandPaths(p as unknown as MigrateStartParams, ['stateDir', 'vaultPath'])));
  registerMethod('migrate.resume', (p) => handleMigrateResume(expandPaths(p as unknown as MigrateResumeParams, ['stateDir', 'vaultPath'])));
  registerMethod('cleanup.unfavorite', (p) => handleCleanupUnfavorite(expandPaths(p as unknown as CleanupUnfavoriteParams, ['stateDir'])));
  registerMethod('status.query', (p) => handleStatusQuery(expandPaths(p as unknown as StatusQueryParams, ['stateDir'])));
}

// ─── auth ───

async function handleAuthLogin(params: AuthLoginParams | undefined): Promise<AuthLoginResult> {
  if (params === undefined) throw new Error('missing params');
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
    const result = await runLoginFlow({
      session,
      // 不传 favoritesUrl → 导航到首页，等用户手动登录
      loginTimeoutMs: params.timeoutMs ?? 300_000,
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
    await session.close();
  }
}

async function handleAuthStatus(params: AuthStatusParams | undefined): Promise<AuthStatusResult> {
  if (params === undefined) throw new Error('missing params');
  const pPath = profilePath(params.stateDir, params.source);
  return {
    profileExists: profileExists(params.stateDir, params.source),
    profilePath: pPath,
  };
}

async function handleAuthClear(params: AuthStatusParams | undefined): Promise<{ cleared: boolean }> {
  if (params === undefined) throw new Error('missing params');
  const pPath = profilePath(params.stateDir, params.source);
  if (!profileExists(params.stateDir, params.source)) {
    return { cleared: false };
  }
  rmSync(pPath, { recursive: true, force: true });
  return { cleared: true };
}

// ─── scan ───

async function handleScanStart(params: ScanStartParams | undefined): Promise<ScanStartResult> {
  if (params === undefined) throw new Error('missing params');
  const profileDir = profilePath(params.stateDir, params.source);
  if (!profileExists(params.stateDir, params.source)) {
    throw new Error(`Profile 不存在：${profileDir}，请先 auth.login`);
  }

  const session = new ToutiaoBrowserSession({
    profileDir,
    headless: params.headless ?? false,
  });
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

    sendNotification('log', {
      level: 'info',
      message: `扫描完成：${scanResult.uniqueItems} 条`,
    });

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

async function runMigrateJob(
  params: MigrateStartParams | MigrateResumeParams,
  isResume: boolean,
): Promise<MigrateResult> {
  // 动态导入避免顶层依赖循环
  const { runMigrationJob } = await import('@inkmigrate/core');

  mkdirSync(params.stateDir, { recursive: true });
  const db: DB = openDatabase({ path: join(params.stateDir, 'inkmigrate.sqlite') });

  try {
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

    // 确保实例存在（FK 约束要求）
    ensureInstance(db, sourceInstanceId, 'toutiao', 'source');
    ensureInstance(db, targetInstanceId, 'obsidian', 'target');

    // 创建新 Job
    const jobId = `mig-${Date.now()}`;
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

    // 构造 source adapter
    const profileDir = profilePath(params.stateDir, sourceInstanceId);
    if (!profileExists(params.stateDir, sourceInstanceId)) {
      throw new Error(`Profile 不存在：${profileDir}，请先 auth.login`);
    }
    const adapterConfig: ToutiaoBrowserAdapterConfig = {
      sourceInstanceId,
      profileDir,
      headless: false,
    };
    const startParams = params as MigrateStartParams;
    if (startParams.favoritesUrl !== undefined) {
      adapterConfig.favoritesUrl = startParams.favoritesUrl;
    }
    if (startParams.maxItems !== undefined) {
      adapterConfig.maxScanItems = startParams.maxItems;
    }
    const sourceAdapter = createToutiaoSource(adapterConfig);

    // 构造 target
    // intervalMs 放在 config（job-runner 从 config 读取），不能放 targetConfig（ObsidianTargetConfigSchema strict 会拒绝）
    const targetAdapter = createObsidianTarget();
    const targetContext: TargetContext = {
      config: {
        ...(startParams.intervalMs !== undefined
          ? { intervalMs: startParams.intervalMs }
          : {}),
      },
      workspaceDir: params.stateDir,
      vaultPath: params.vaultPath,
      targetConfig: {
        vaultPath: params.vaultPath,
        importSubdir: '',
        attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink',
        overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false },
        maxFilenameLength: 100,
      } as Record<string, unknown>,
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
      onProgress: (progress) => {
        // 把 job-runner 进度转发为 JSON-RPC notification
        sendNotification('progress', {
          jobId: progress.jobId,
          phase: progress.phase,
          current: progress.current,
          total: progress.total,
          ...(progress.currentItem !== undefined ? { currentItem: progress.currentItem } : {}),
          ...(progress.counts !== undefined ? { counts: progress.counts } : {}),
        });
      },
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
    db.close();
  }
}

// ─── cleanup ───

async function handleCleanupUnfavorite(
  params: CleanupUnfavoriteParams | undefined,
): Promise<CleanupResult> {
  if (params === undefined) throw new Error('missing params');
  const db: DB = openDatabase({ path: join(params.stateDir, 'inkmigrate.sqlite') });
  try {
    const limit = params.maxItems;
    const rows = db
      .prepare(
        `SELECT canonical_url, title, external_id, content_kind, fingerprint, discovered_at
         FROM source_items
         WHERE source_instance_id = ? AND status = 'verified'
         ORDER BY source_position ASC
         ${limit ? 'LIMIT ?' : ''}`,
      )
      .all(params.source, ...(limit ? [limit] : [])) as Array<{
        canonical_url: string;
        title: string;
        external_id: string | null;
        content_kind: string;
        fingerprint: string;
        discovered_at: string;
      }>;

    if (rows.length === 0) {
      return { successCount: 0, skipCount: 0, failCount: 0 };
    }

    const profileDir = profilePath(params.stateDir, params.source);
    if (!profileExists(params.stateDir, params.source)) {
      throw new Error(`Profile 不存在：${profileDir}，请先 auth.login`);
    }

    const adapter = createToutiaoSource({
      sourceInstanceId: params.source,
      profileDir,
      headless: false,
    });
    await adapter.prepare({ config: {}, workspaceDir: params.stateDir });

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      sendNotification('progress', {
        phase: 'cleanup',
        current: i + 1,
        total: rows.length,
        currentItem: row.title?.substring(0, 50),
      });

      const ref = {
        sourceInstanceId: params.source,
        canonicalUrl: row.canonical_url,
        originalUrl: row.canonical_url,
        title: row.title,
        contentKind: row.content_kind as 'article' | 'short-post' | 'gallery' | 'question-answer' | 'video' | 'note' | 'external-link' | 'unknown',
        discoveredAt: row.discovered_at || new Date().toISOString(),
        fingerprint: row.fingerprint || '',
        sourceMetadata: {},
        ...(row.external_id ? { externalId: row.external_id } : {}),
      };

      try {
        const result = (await adapter.cleanup!.executeAction(
          ref,
          'unfavorite',
          { config: {}, workspaceDir: params.stateDir },
        )) as { success: boolean; wasCollected: boolean; reason?: string };

        if (result.success) {
          if (result.wasCollected) successCount++;
          else skipCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    await adapter.close();
    return { successCount, skipCount, failCount };
  } finally {
    db.close();
  }
}

// ─── status ───

async function handleStatusQuery(
  params: StatusQueryParams | undefined,
): Promise<StatusQueryResult> {
  if (params === undefined) throw new Error('missing params');
  const db: DB = openDatabase({ path: join(params.stateDir, 'inkmigrate.sqlite') });
  try {
    const job = new MigrationJobs(db).get(params.job);
    return {
      status: job.status,
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
