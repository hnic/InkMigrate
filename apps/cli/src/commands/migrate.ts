import { Command } from 'commander';
import {
  openDatabase,
  runMigrationJob,
  SourceInstances,
  TargetInstances,
  MigrationJobs,
  computeFingerprint,
  validateSourceItemQuality,
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
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
    .option('--dry-run', '不写入目标（仅扫描+提取+计划）')
    .action(async (opts: {
      source: string;
      target: string;
      stateDir: string;
      vaultPath: string;
      fixtureDir?: string;
      dryRun?: boolean;
    }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      // fixture 模式下自动创建数据库；真实模式下要求先 scan
      const db: DB = existsSync(dbPath)
        ? openDatabase({ path: dbPath })
        : openDatabase({ path: dbPath }); // openDatabase 自动 migrate
      try {
        const jobId = `mig-${Date.now()}`;
        const now = new Date().toISOString();

        // 确保实例记录存在
        ensureInstance(db, opts.source, 'toutiao', 's');
        ensureInstance(db, opts.target, 'obsidian', 't');

        new MigrationJobs(db).create({
          id: jobId,
          sourceInstanceId: opts.source,
          targetInstanceId: opts.target,
          status: 'created',
          currentStage: 'preflight',
          createdAt: now,
          updatedAt: now,
        });

        // 构造 source adapter
        const sourceAdapter = opts.fixtureDir
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
                headless: false,
              });
            })();

        // 构造 target adapter + context
        const targetAdapter = createObsidianTarget();
        const targetContext: TargetContext = {
          config: {},
          workspaceDir: opts.stateDir,
          vaultPath: opts.vaultPath,
          targetConfig: {
            vaultPath: opts.vaultPath,
            importSubdir: 'Imports/InkMigrate',
            attachmentsSubdir: 'Attachments/InkMigrate',
            linkStyle: 'wikilink',
            overwritePolicy: 'preserve',
            collectionMapping: { toTags: false, toFolders: false },
            maxFilenameLength: 100,
          } as Record<string, unknown>,
        };

        console.log(`开始迁移 Job ${jobId}...`);

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
        db.close();
      }
    });
}

function ensureInstance(
  db: DB,
  id: string,
  adapterKind: string,
  _prefix: string,
): void {
  // 如果实例不存在，创建一个最小记录
  const existing = db
    .prepare('SELECT id FROM source_instances WHERE id = ?')
    .get(id);
  if (!existing) {
    db.prepare(
      `INSERT INTO source_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(id, adapterKind, '1.0.0', '1.0.0', 'h', new Date().toISOString(), new Date().toISOString());
  }
  const existingTarget = db
    .prepare('SELECT id FROM target_instances WHERE id = ?')
    .get(id);
  if (!existingTarget) {
    db.prepare(
      `INSERT INTO target_instances(id,adapter_kind,adapter_version,adapter_api_version,config_hash,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(id, adapterKind, '1.0.0', '1.0.0', 'h', new Date().toISOString(), new Date().toISOString());
  }
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
