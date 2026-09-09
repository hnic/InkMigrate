import { Command } from 'commander';
import {
  openDatabase,
  runMigrationJob,
  MigrationJobs,
  computeFingerprint,
  loadConfigFromString,
  validateSourceItemQuality,
  ensureInstance,
  type SourceAdapter,
  type SourceItem,
  type SourceItemRef,
  type TargetContext,
  type DB,
} from '@inkmigrate/core';
import {
  createToutiaoSource,
  scanFavoritesList,
  extractDetail,
  deriveFingerprintInput,
  profilePath,
  profileExists,
} from '@inkmigrate/source-toutiao';
import { createEvernoteSource } from '@inkmigrate/source-evernote';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parsePositiveInt } from '../util.js';

/**
 * §22 `inkmigrate migrate` 命令。
 *
 * 驱动完整的 scan→extract→write→verify→reconcile→report 闭环。
 *
 * v1.0-rc1：source 通过 `--fixture-dir` 指定 fixture HTML 目录（测试模式），
 * 或通过真实浏览器 Profile（需要 stage 3 的 Playwright 接入，v1.0 发布前完善）。
 * target 始终用真实 Obsidian 适配器写 Vault。
 */
export function createMigrateCommand(): Command {
  return new Command('migrate')
    .description('执行迁移 Job（扫描→提取→写入→验证→报告）')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--target <id>', '目标实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .requiredOption('--vault-path <path>', 'Obsidian Vault 路径')
    .option('--fixture-dir <path>', 'fixture HTML 目录（测试模式，不启动浏览器）')
    .option('--config <path>', 'inkmigrate.yaml 配置路径（按 adapter 选择来源类型）', 'inkmigrate.yaml')
    .option('--favorites-url <url>', '收藏列表 URL（真实模式）')
    .option('--max-items <n>', '限制扫描+迁移条目数（用于测试）')
    .option('--interval <ms>', '条目间请求间隔毫秒数（默认 1500，防风控）')
    // 注：--dry-run 此前声明但从未实现（action 内不读 opts.dryRun，会真实写入 Vault），
    // 误导用户。遵循"如实报告而非静默假装"原则移除该选项。如需不落盘测试，
    // 请用 --fixture-dir 配合临时 vault-path。
    .action(async (opts: {
      source: string;
      target: string;
      stateDir: string;
      vaultPath: string;
      fixtureDir?: string;
      config?: string;
      favoritesUrl?: string;
      maxItems?: string;
      interval?: string;
    }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      // N1: openDatabase 会自动 migrate（不存在则建库），两个分支等价，去掉冗余三元。
      const db: DB = openDatabase({ path: dbPath });
      try {
        const jobId = `mig-${Date.now()}`;
        const now = new Date().toISOString();

        // §10.2 配置驱动的适配器选择：inkmigrate.yaml 中 adapter: evernote 的来源
        // 走文件源（ENEX/HTML 导出目录，无需浏览器登录）。未命中配置时维持
        // toutiao 浏览器流程（含 --fixture-dir 测试模式）。
        let sourceAdapterKind = 'toutiao';
        let evernoteAdapter: SourceAdapter | undefined;
        let evernoteInstanceConfig: Record<string, unknown> | undefined;
        const configPath = resolve(opts.config ?? 'inkmigrate.yaml');
        if (existsSync(configPath)) {
          const cfg = loadConfigFromString(readFileSync(configPath, 'utf8'));
          const src = cfg.sources.find((s) => s.id === opts.source);
          if (src !== undefined && src.adapter === 'evernote') {
            if (!src.enabled) {
              console.error(`来源 ${opts.source} 在配置中处于 enabled: false 状态，已跳过。`);
              process.exit(1);
            }
            const raw = src.config as Record<string, unknown>;
            const inputPaths = Array.isArray(raw.inputPaths)
              ? (raw.inputPaths as string[]).map((p) => resolve(dirname(configPath), p))
              : [];
            if (inputPaths.length === 0) {
              console.error(`来源 ${opts.source} 缺少 inputPaths（ENEX/HTML 导出目录）。`);
              process.exit(1);
            }
            evernoteAdapter = createEvernoteSource({
              sourceInstanceId: src.id,
              ...raw,
              inputPaths,
            });
            evernoteInstanceConfig = raw;
            sourceAdapterKind = 'evernote';
          }
        }

        // 构造 source adapter
        const sourceAdapter =
          evernoteAdapter !== undefined
            ? evernoteAdapter
            : opts.fixtureDir
              ? createFixtureSource(opts.fixtureDir, opts.source)
              : (() => {
                  const profileDir = profilePath(opts.stateDir, opts.source);
                  if (!profileExists(opts.stateDir, opts.source)) {
                    console.error(`未找到 Profile：${profileDir}`);
                    console.error(
                      `请先运行：inkmigrate auth login --source ${opts.source} --state-dir ${opts.stateDir}`,
                    );
                    process.exit(1);
                  }
                  return createToutiaoSource({
                    sourceInstanceId: opts.source,
                    profileDir,
                    headless: false, // 有头：头条反爬会拦截 headless
                    ...(opts.favoritesUrl !== undefined
                      ? { favoritesUrl: opts.favoritesUrl }
                      : {}),
                    ...(opts.maxItems !== undefined
                      ? { maxScanItems: parsePositiveInt(opts.maxItems, 'max-items') }
                      : {}),
                  });
                })();

        // 构造 target adapter + context
        // intervalMs 作为 runMigrationJob 一级字段传入（§18.1 类型化速率控制契约），
        // 不再塞 config bag（后者是 Record<string,unknown>，强转读取无类型保障）。
        const targetAdapter = createObsidianTarget();
        const targetContext: TargetContext = {
          config: {},
          workspaceDir: opts.stateDir,
          vaultPath: opts.vaultPath,
          targetConfig: {
            vaultPath: opts.vaultPath,
            importSubdir: '',
            attachmentsSubdir: 'Attachments',
            linkStyle: 'wikilink',
            overwritePolicy: 'preserve',
            collectionMapping: { toTags: false, toFolders: false },
            maxFilenameLength: 100,
          } as Record<string, unknown>,
        };

        // H5: 确保实例记录存在——移到 config 构造后，传入实际 config 以计算真实
        // config_hash（原硬编码 'h' 与 Engine 的真实哈希分叉，导致 CLI 创建的 instance
        // 随后被 GUI 迁移看到哈希「变化」触发虚假 UPDATE）。
        ensureInstance(
          db,
          opts.source,
          sourceAdapterKind,
          'source',
          sourceAdapterKind === 'evernote'
            ? (evernoteInstanceConfig ?? {})
            : {
                sourceInstanceId: opts.source,
                profileDir: profilePath(opts.stateDir, opts.source),
                headless: false,
              },
        );
        ensureInstance(db, opts.target, 'obsidian', 'target', targetContext.targetConfig);

        new MigrationJobs(db).create({
          id: jobId,
          sourceInstanceId: opts.source,
          targetInstanceId: opts.target,
          status: 'created',
          currentStage: 'preflight',
          createdAt: now,
          updatedAt: now,
        });

        console.log(`开始迁移 Job ${jobId}...`);

        // L16: SIGINT 协作取消（与 cleanup 命令一致）。原 migrate/resume 无 SIGINT 处理，
        // Ctrl+C 硬杀会留 Job 状态 running 直到 stale-running 兜底。改为置标志，让
        // runMigrationJob 在条目间优雅终止并落库已处理项。
        let cancelled = false;
        const onSigInt = () => {
          cancelled = true;
          console.log('\n收到终止信号，正在停止当前任务（已处理项已落库，可 resume 续跑）...');
        };
        process.on('SIGINT', onSigInt);

        try {
          const result = await runMigrationJob({
            db,
            jobId,
            sourceAdapter,
            targetAdapter,
            sourceInstanceId: opts.source,
            targetInstanceId: opts.target,
            targetContext,
            workspaceDir: opts.stateDir,
            reportsDir: join(opts.stateDir, 'reports'),
            isCancelled: () => cancelled,
            // L17: parseInt 可能产生 NaN（用户传非数字），校验后再传入，避免 NaN 直达
            // 速率控制（I25：NaN interval → 最快速率 → 封号）。
            ...(opts.interval !== undefined
              ? { intervalMs: parsePositiveInt(opts.interval, 'interval') }
              : {}),
          });

          console.log(`\n迁移完成：`);
          console.log(`  status: ${result.status}`);
          console.log(`  scan_count: ${result.scanCount}`);
          console.log(`  reconciliation: ${result.reconciliationOk ? '通过' : '失败'}`);
          if (result.reconciliationReason) {
            console.log(`  reason: ${result.reconciliationReason}`);
          }
          console.log(`\n报告：${join(opts.stateDir, 'reports', jobId, 'summary.md')}`);
        } finally {
          process.off('SIGINT', onSigInt);
        }
      } finally {
        db.close();
      }
    });
}

function createFixtureSource(
  fixtureDir: string,
  sourceInstanceId: string,
): SourceAdapter {
  const favoritesHtml = readFileSync(
    join(fixtureDir, 'favorites-list.html'),
    'utf8',
  );
  const articleHtml = readFileSync(join(fixtureDir, 'article.html'), 'utf8');

  const real = createToutiaoSource();
  return {
    ...real,
    async *scan() {
      const result = await scanFavoritesList({
        initialHtml: favoritesHtml,
        baseUrl: 'https://www.toutiao.com/',
        scrollForMore: async () => null,
        maxEmptyCycles: 1,
      });
      for (const fav of result.items) {
        const fpBuilder: Parameters<typeof deriveFingerprintInput>[0] = {
          canonicalUrl: fav.canonicalUrl,
        };
        if (fav.externalId) fpBuilder.contentId = fav.externalId;
        const fp = computeFingerprint(deriveFingerprintInput(fpBuilder));
        const ref: SourceItemRef = {
          sourceInstanceId,
          canonicalUrl: fav.canonicalUrl,
          originalUrl: fav.originalUrl,
          title: fav.title,
          contentKind: fav.contentKind,
          discoveredAt: new Date().toISOString(),
          fingerprint: fp,
          sourceMetadata: fav.sourceMetadata,
        };
        if (fav.externalId) ref.externalId = fav.externalId;
        yield ref;
      }
    },
    async extract(ref) {
      const url = ref.canonicalUrl ?? '';
      const detail = extractDetail({
        html: articleHtml,
        canonicalUrl: url,
        originalUrl: url,
      });
      validateSourceItemQuality(detail.quality, detail.degradations);
      const item: SourceItem = {
        ref,
        title: detail.title,
        tags: [],
        collections: [],
        assets: [],
        links: [],
        quality: detail.quality,
        degradations: detail.degradations,
        extractionMethod: 'fixture',
        extractionWarnings: [],
        sourceMetadata: {},
      };
      if (detail.markdown) item.bodyText = detail.markdown;
      return item;
    },
  };
}
