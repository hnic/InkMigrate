import { Command } from 'commander';
import {
  openDatabase,
  runMigrationJob,
  MigrationJobs,
  type TargetContext,
  type DB,
} from '@inkmigrate/core';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSourceWiring, resolveTargetConfig } from '@inkmigrate/wiring';
import {
  DB_FILENAME,
  CONFIG_FILENAME,
  REPORTS_DIR_NAME,
  REPORT_FILENAME,
  parseOptionalPositiveInt,
} from '../util.js';

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
    .option('--config <path>', 'inkmigrate.yaml 配置路径（按 adapter 选择来源类型）', CONFIG_FILENAME)
    .action(async (opts: {
      job: string;
      stateDir: string;
      vaultPath: string;
      favoritesUrl?: string;
      maxItems?: string;
      config?: string;
    }) => {
      // --max-items 校验前置（与 migrate 一致）：parseInt 对非数字给出 NaN，
      // 会绕过 wiring 的 !== undefined 检查以 maxScanItems: NaN 直达驱动，
      // 数值比较恒假等于限额被静默关闭
      const maxItems = parseOptionalPositiveInt(opts.maxItems, 'max-items');
      const dbPath = join(opts.stateDir, DB_FILENAME);
      if (!existsSync(dbPath)) {
        console.error(`数据库不存在：${dbPath}`);
        process.exit(1);
      }

      const db: DB = openDatabase({ path: dbPath });
      try {
        const jobs = new MigrationJobs(db);
        // 读取原 Job 信息
        const oldJob = jobs.get(opts.job);
        if (oldJob === undefined) {
          console.error(`Job ${opts.job} 不存在，无法续跑`);
          // 用 exitCode+return 而非 process.exit：同步 exit 会跳过外层
          // finally { db.close() }，丢弃本命令显式安排的清理
          process.exitCode = 1;
          return;
        }
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

        // 创建新 Job（随机后缀免疫毫秒碰撞/时钟回拨，与 migrate 一致）
        const jobId = `mig-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        // 确定性关闭旧 Job：原 Job 若因崩溃/SIGKILL 停留在非终态，直接另建后继
        // 会让同一实例对出现两个 running 行，正确性只能靠 stale-running 兜底。
        // 终态（completed/failed）状态机不可再转换，跳过
        if (
          oldJob.status === 'created' ||
          oldJob.status === 'running' ||
          oldJob.status === 'paused' ||
          oldJob.status === 'interrupted'
        ) {
          jobs.updateStatus(opts.job, { status: 'failed', updatedAt: now });
        }
        jobs.create({
          id: jobId,
          sourceInstanceId,
          targetInstanceId,
          status: 'created',
          currentStage: 'preflight',
          createdAt: now,
          updatedAt: now,
        });

        // 构造 source adapter：与 migrate 同一接线（yaml 命中 evernote → 文件源，
        // 否则 toutiao 浏览器 + Profile 校验）
        const wiring = resolveSourceWiring({
          config: opts.config ?? CONFIG_FILENAME,
          sourceId: sourceInstanceId,
          stateDir: opts.stateDir,
          ...(opts.favoritesUrl !== undefined ? { favoritesUrl: opts.favoritesUrl } : {}),
          ...(maxItems !== undefined ? { maxItems } : {}),
        });
        const sourceAdapter = wiring.adapter;

        const targetAdapter = createObsidianTarget();
        const targetContext: TargetContext = {
          config: {},
          workspaceDir: opts.stateDir,
          vaultPath: opts.vaultPath,
          targetConfig: resolveTargetConfig(
            opts.config ?? CONFIG_FILENAME,
            targetInstanceId,
            opts.vaultPath,
          ),
        };

        console.log(`\n开始恢复迁移 Job ${jobId}（跳过 ${verifiedItems} 条已完成）...`);

        // R2: SIGINT 协作取消（与 migrate 命令一致，L16 漏了 resume）。
        let cancelled = false;
        const onSigInt = () => {
          cancelled = true;
          console.log('\n收到终止信号，正在停止当前任务（已处理项已落库，可再次 resume）...');
        };
        process.on('SIGINT', onSigInt);

        try {
          const result = await runMigrationJob({
            db,
            jobId,
            sourceAdapter,
            targetAdapter,
            sourceInstanceId,
            targetInstanceId,
            targetContext,
            workspaceDir: opts.stateDir,
            reportsDir: join(opts.stateDir, REPORTS_DIR_NAME),
            isCancelled: () => cancelled,
          });

          console.log(`\n迁移完成：`);
          console.log(`  status: ${result.status}`);
          console.log(`  scan_count: ${result.scanCount}`);
          console.log(`  reconciliation: ${result.reconciliationOk ? '通过' : '失败'}`);
          if (result.reconciliationReason) {
            console.log(`  reason: ${result.reconciliationReason}`);
          }
          console.log(`\n报告：${join(opts.stateDir, REPORTS_DIR_NAME, jobId, REPORT_FILENAME)}`);
        } catch (err) {
          // runMigrationJob 内部只有 finally（无 catch）：错误上抛时 Job 行停留在
          // running。CLI 每次生成新 jobId，core 的孤儿自愈覆盖不到，显式落库
          // failed（与 migrate 命令一致），否则只能等 stale-running 兜底。
          try {
            jobs.updateStatus(jobId, {
              status: 'failed',
              updatedAt: new Date().toISOString(),
            });
          } catch {
            // 状态落库失败不应掩盖原始错误
          }
          console.error(`恢复迁移失败，Job ${jobId} 已标记为 failed。`);
          throw err;
        } finally {
          process.off('SIGINT', onSigInt);
        }
      } finally {
        db.close();
      }
    });
}
