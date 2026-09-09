import { Command } from 'commander';
import {
  openDatabase,
  runMigrationJob,
  MigrationJobs,
  computeFingerprint,
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
} from '@inkmigrate/source-toutiao';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parsePositiveInt, parseOptionalPositiveInt, DB_FILENAME } from '../util.js';
import { buildToutiaoSource, resolveEvernoteSource, resolveTargetConfig } from '@inkmigrate/wiring';

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
      const dbPath = join(opts.stateDir, DB_FILENAME);
      // N1: openDatabase 会自动 migrate（不存在则建库），两个分支等价，去掉冗余三元。
      const db: DB = openDatabase({ path: dbPath });
      try {
        // 同毫秒并发启动会撞主键（migration_jobs.id），附随机后缀
        const jobId = `mig-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        // commander 选项已带默认值，这里归一一次供下方各处复用
        const configPath = opts.config ?? 'inkmigrate.yaml';
        // max-items 解析一次，fixture 与浏览器模式共用
        const maxItems = parseOptionalPositiveInt(opts.maxItems, 'max-items');

        // §10.2 配置驱动的适配器选择（migrate/resume 共用接线，见 source-wiring.ts）：
        // yaml 命中 adapter: evernote → 文件源；否则 toutiao 浏览器（--fixture-dir
        // 测试模式优先，不读 yaml——避免无关的配置错误阻塞 fixture 流程）。
        let sourceAdapter: SourceAdapter;
        let sourceAdapterKind: 'evernote' | 'toutiao';
        let sourceInstanceConfig: Record<string, unknown>;
        if (opts.fixtureDir !== undefined) {
          sourceAdapter = createFixtureSource(opts.fixtureDir, opts.source, maxItems);
          sourceAdapterKind = 'toutiao';
          // 与 buildToutiaoSource 的 instanceConfig 保持一致（fixture 模式不能直接
          // 调用它——Profile 缺失时它会 process.exit）
          sourceInstanceConfig = {
            sourceInstanceId: opts.source,
            profileDir: profilePath(opts.stateDir, opts.source),
            headless: false,
          };
        } else {
          const wiring =
            resolveEvernoteSource({ config: configPath, sourceId: opts.source }) ??
            buildToutiaoSource({
              sourceId: opts.source,
              stateDir: opts.stateDir,
              ...(opts.favoritesUrl !== undefined ? { favoritesUrl: opts.favoritesUrl } : {}),
              ...(maxItems !== undefined ? { maxItems } : {}),
            });
          sourceAdapter = wiring.adapter;
          sourceAdapterKind = wiring.kind;
          // 复用 wiring 生成的 instanceConfig，避免本地副本与接线层漂移导致
          // config_hash 分叉（GUI/resume 路径会看到虚假的配置 UPDATE）
          sourceInstanceConfig = wiring.instanceConfig;
        }

        // 构造 target adapter + context
        // intervalMs 作为 runMigrationJob 一级字段传入（§18.1 类型化速率控制契约），
        // 不再塞 config bag（后者是 Record<string,unknown>，强转读取无类型保障）。
        const targetAdapter = createObsidianTarget();
        const targetContext: TargetContext = {
          config: {},
          workspaceDir: opts.stateDir,
          vaultPath: opts.vaultPath,
          // yaml 命中 obsidian target 时用其配置（含 §13.3 默认 Imports/InkMigrate
          // 目录结构）；否则维持 legacy 硬编码（头条老用户路径不变）
          targetConfig: resolveTargetConfig(configPath, opts.target, opts.vaultPath),
        };

        // H5: 确保实例记录存在——移到 config 构造后，传入实际 config 以计算真实
        // config_hash（原硬编码 'h' 与 Engine 的真实哈希分叉，导致 CLI 创建的 instance
        // 随后被 GUI 迁移看到哈希「变化」触发虚假 UPDATE）。
        // 版本列取适配器实例真实值（审计列不再落占位 '1.0.0'）。
        ensureInstance(db, opts.source, sourceAdapterKind, 'source', sourceInstanceConfig, {
          adapterVersion: sourceAdapter.version,
          adapterApiVersion: sourceAdapter.adapterApiVersion,
        });
        ensureInstance(db, opts.target, 'obsidian', 'target', targetContext.targetConfig, {
          adapterVersion: targetAdapter.version,
          adapterApiVersion: targetAdapter.adapterApiVersion,
        });

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
        } catch (err) {
          // runMigrationJob 内部只有 finally（无 catch）：错误上抛时 Job 行停留在
          // running。CLI 每次生成新 jobId，core 的孤儿自愈（同 jobId 重跑触发）
          // 覆盖不到，这里显式落库 failed，否则只能等 stale-running 兜底。
          try {
            new MigrationJobs(db).updateStatus(jobId, {
              status: 'failed',
              updatedAt: new Date().toISOString(),
            });
          } catch {
            // 状态落库失败不应掩盖原始错误
          }
          console.error(`迁移失败，Job ${jobId} 已标记为 failed。`);
          throw err;
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
  maxItems?: number,
): SourceAdapter {
  const favoritesPath = join(fixtureDir, 'favorites-list.html');
  const articlePath = join(fixtureDir, 'article.html');
  if (!existsSync(favoritesPath) || !existsSync(articlePath)) {
    // 目录写错时给明确提示，而非 ENOENT 堆栈
    throw new Error(
      `fixture 目录不完整：${fixtureDir} 需包含 favorites-list.html 与 article.html`,
    );
  }
  const favoritesHtml = readFileSync(favoritesPath, 'utf8');
  const articleHtml = readFileSync(articlePath, 'utf8');

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
      // --max-items 在 fixture 测试模式同样生效（限制扫描+迁移条目数）
      const items =
        maxItems === undefined ? result.items : result.items.slice(0, maxItems);
      for (const fav of items) {
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
      if (ref.canonicalUrl === undefined) {
        // 空 URL 会污染 links/asset 元数据及下游 URL 逻辑，明确拒绝而非静默兜底
        throw new Error(
          `fixture 条目缺少 canonicalUrl，无法提取：${ref.title ?? '(untitled)'}`,
        );
      }
      const url = ref.canonicalUrl;
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
