import { Command } from 'commander';
import {
  openDatabase,
  runMigrationJob,
  MigrationJobs,
  type SourceAdapter,
  type TargetContext,
  type DB,
} from '@inkmigrate/core';
import {
  createToutiaoSource,
  profilePath,
  profileExists,
} from '@inkmigrate/source-toutiao';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * §22 `inkmigrate resume` 命令。
 *
 * 恢复中断的迁移 Job：创建新 Job，自动跳过已 verified 的条目。
 * job-runner 的 processOneItem 会检查 source_items.status，
 * 已 verified 的条目直接返回，不重新提取。
 *
 * 用法：
 *   inkmigrate resume --job <old-job-id> --state-dir .inkmigrate \
 *     --vault-path /path/to/vault --favorites-url "https://..."
 */
export function createResumeCommand(): Command {
  return new Command('resume')
    .description('恢复中断的迁移 Job（跳过已完成条目）')
    .requiredOption('--job <id>', '原 Job ID（用于继承配置和条目）')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .requiredOption('--vault-path <path>', 'Obsidian Vault 路径')
    .option('--favorites-url <url>', '收藏列表 URL（真实模式）')
    .option('--max-items <n>', '限制迁移条目数')
    .action(async (opts: {
      job: string;
      stateDir: string;
      vaultPath: string;
      favoritesUrl?: string;
      maxItems?: string;
    }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      if (!existsSync(dbPath)) {
        console.error(`数据库不存在：${dbPath}`);
        process.exit(1);
      }

      const db: DB = openDatabase({ path: dbPath });
      try {
        // 读取原 Job 信息
        const oldJob = new MigrationJobs(db).get(opts.job);
        const sourceInstanceId = oldJob.sourceInstanceId;
        const targetInstanceId = oldJob.targetInstanceId;

        // 统计已完成和未完成的条目
        const totalItems = (
          db
            .prepare('SELECT COUNT(*) as c FROM source_items WHERE source_instance_id = ?')
            .get(sourceInstanceId) as { c: number }
        ).c;
        const verifiedItems = (
          db
            .prepare("SELECT COUNT(*) as c FROM source_items WHERE source_instance_id = ? AND status = 'verified'")
            .get(sourceInstanceId) as { c: number }
        ).c;

        console.log(`恢复 Job ${opts.job}:`);
        console.log(`  来源: ${sourceInstanceId}`);
        console.log(`  目标: ${targetInstanceId}`);
        console.log(`  已完成: ${verifiedItems}/${totalItems}`);
        console.log(`  待迁移: ${totalItems - verifiedItems}`);

        if (verifiedItems === totalItems && totalItems > 0) {
          console.log('\n所有条目已完成，无需恢复。');
          return;
        }

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

        // 构造 source adapter（真实浏览器模式）
        const profileDir = profilePath(opts.stateDir, sourceInstanceId);
        if (!profileExists(opts.stateDir, sourceInstanceId)) {
          console.error(`未找到 Profile：${profileDir}`);
          process.exit(1);
        }
        const sourceAdapter = createToutiaoSource({
          sourceInstanceId,
          profileDir,
          headless: false, // 有头：头条反爬会拦截 headless
          ...(opts.favoritesUrl !== undefined ? { favoritesUrl: opts.favoritesUrl } : {}),
          ...(opts.maxItems !== undefined ? { maxScanItems: parseInt(opts.maxItems, 10) } : {}),
        });

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

        console.log(`\n开始恢复迁移 Job ${jobId}（跳过 ${verifiedItems} 条已完成）...`);

        const result = await runMigrationJob({
          db,
          jobId,
          sourceAdapter,
          targetAdapter,
          sourceInstanceId,
          targetInstanceId,
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
