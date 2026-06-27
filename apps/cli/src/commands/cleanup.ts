import { Command } from 'commander';
import { openDatabase, type DB } from '@inkmigrate/core';
import {
  createToutiaoSource,
  profilePath,
  profileExists,
  buildConfirmationPrompt,
  validateConfirmation,
  runCleanupUnfavorite,
  type ToutiaoBrowserAdapterConfig,
} from '@inkmigrate/source-toutiao';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * §12.7 `inkmigrate cleanup unfavorite` 命令。
 *
 * 从数据库读取已迁移（verified）的条目，逐条打开文章详情页点击取消收藏。
 * 默认要求终端逐字输入确认短语（§14.6）；传 --force 跳过。
 *
 * 用法：
 *   inkmigrate cleanup unfavorite \
 *     --source toutiao-main \
 *     --state-dir .inkmigrate \
 *     --max-items 3 \
 *     [--force]
 */
export function createCleanupCommand(): Command {
  const cleanup = new Command('cleanup').description('源端清理：取消收藏');

  // cleanup status — 查看可清理的条目统计
  cleanup
    .command('status')
    .description('查看可清理的条目统计')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { source: string; stateDir: string }) => {
      const db: DB = openDatabase({ path: join(opts.stateDir, 'inkmigrate.sqlite') });
      try {
        const total = (
          db
            .prepare('SELECT COUNT(*) as c FROM source_items WHERE source_instance_id = ?')
            .get(opts.source) as { c: number }
        ).c;
        const verified = (
          db
            .prepare("SELECT COUNT(*) as c FROM source_items WHERE source_instance_id = ? AND status = 'verified'")
            .get(opts.source) as { c: number }
        ).c;
        const degraded = (
          db
            .prepare("SELECT COUNT(*) as c FROM source_items WHERE source_instance_id = ? AND status = 'degraded'")
            .get(opts.source) as { c: number }
        ).c;

        console.log(`来源 ${opts.source} 清理状态：`);
        console.log(`  总条目: ${total}`);
        console.log(`  已验证（可清理）: ${verified}`);
        console.log(`  降级: ${degraded}`);
        console.log(`  可清理比例: ${total > 0 ? Math.round((verified / total) * 100) : 0}%`);
        console.log('');
        console.log('运行 `cleanup unfavorite` 开始取消收藏。');
      } finally {
        db.close();
      }
    });

  cleanup
    .command('unfavorite')
    .description('打开浏览器，逐条取消已迁移条目的收藏')
    .requiredOption('--source <id>', '来源实例 ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .option('--max-items <n>', '单次最多处理条目数（默认 200，防风控；可调高，自担风险）')
    .option('--interval-ms <ms>', '条目间基准间隔毫秒（默认 2000，叠加 ±40% 抖动）')
    .option(
      '--force',
      '跳过终端二次确认（默认必须逐字输入确认短语）',
      false,
    )
    .action(async (opts: {
      source: string;
      stateDir: string;
      maxItems?: string;
      intervalMs?: string;
      force?: boolean;
    }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      const db: DB = openDatabase({ path: dbPath });
      try {
        // 候选计数（用于二次确认的展示；实际候选过滤在编排器内完成，含已成功项排除）
        const candidateCount = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM source_items
               WHERE source_instance_id = ? AND status = 'verified'`,
            )
            .get(opts.source) as { c: number }
        ).c;

        if (candidateCount === 0) {
          console.log('没有已迁移的条目可清理。');
          return;
        }

        console.log(`找到 ${candidateCount} 条已迁移条目（已成功取消的会自动跳过）。`);
        const effectiveMax = opts.maxItems ? parseInt(opts.maxItems, 10) : 200;
        if (candidateCount > effectiveMax) {
          console.log(`⚠️ 防风控：本次将处理前 ${effectiveMax} 条，剩余可分多次运行（已成功项自动跳过）。`);
        }
        console.log('即将逐条打开文章详情页并取消收藏（仅普通文章）。');
        console.log('为防风控，每条会模拟人类阅读（滚动浏览、随机停留）后再取消，单条约 15-30 秒。');
        console.log('出现取消失败（疑似风控）时，原地等待 10 分钟后重试当前条；重试仍失败则停止任务。');
        console.log('');

        // §14.6 危险操作二次确认：未传 --force 时必须逐字输入确认短语。
        // 这是不可逆操作（取消后云端收藏即丢失），默认拒绝执行。
        if (!opts.force) {
          const prefix = 'UNFAVORITE';
          const prompt = buildConfirmationPrompt(candidateCount, prefix);
          console.log(prompt);
          const rl = readline.createInterface({ input, output });
          try {
            const answer = (await rl.question('确认 > ')).trim();
            if (!validateConfirmation(answer, candidateCount, prefix)) {
              console.log('确认不匹配，已取消操作。未做任何更改。');
              process.exit(1);
            }
          } finally {
            rl.close();
          }
          console.log('');
        }

        // 关联迁移任务（满足 cleanup_plans.migration_job_id FK）
        const migrationJobId = resolveLatestMigrationJobId(db, opts.source);

        // 检查 Profile
        const pPath = profilePath(opts.stateDir, opts.source);
        if (!profileExists(opts.stateDir, opts.source)) {
          console.error(`未找到 Profile：${pPath}`);
          console.error(
            `请先运行：inkmigrate auth login --source ${opts.source} --state-dir ${opts.stateDir}`,
          );
          process.exit(1);
        }

        const adapterConfig: ToutiaoBrowserAdapterConfig = {
          sourceInstanceId: opts.source,
          profileDir: pPath,
          headless: false, // 有头：头条反爬会拦截 headless
        };
        const adapter = createToutiaoSource(adapterConfig);
        await adapter.prepare({ config: {}, workspaceDir: opts.stateDir });

        // SIGINT → 置取消标志（编排器每轮检查，优雅终止并落库部分结果）
        let cancelled = false;
        const onSigInt = () => {
          cancelled = true;
          console.log('\n收到终止信号，正在停止当前任务（已处理项已落库）...');
        };
        process.on('SIGINT', onSigInt);

        try {
          const limit = opts.maxItems ? parseInt(opts.maxItems, 10) : undefined;
          const intervalMs = opts.intervalMs ? parseInt(opts.intervalMs, 10) : undefined;
          const result = await runCleanupUnfavorite({
            db,
            sourceAdapter: adapter,
            sourceInstanceId: opts.source,
            migrationJobId,
            workspaceDir: opts.stateDir,
            ...(limit !== undefined ? { maxItems: limit } : {}),
            ...(intervalMs !== undefined ? { intervalMs } : {}),
            isCancelled: () => cancelled,
            onProgress: (p) =>
              console.log(`[${p.current}/${p.total}] ${p.currentItem ?? ''}`),
            onLog: (e) => console.log(e.message),
          });

          console.log('\n========== 清理完成 ==========');
          console.log(`  成功取消收藏: ${result.successCount}`);
          console.log(`  跳过（未收藏）: ${result.skippedCount}`);
          console.log(`  失败: ${result.failedCount}`);
          if (result.unknownCount > 0) {
            console.log(`  未知（状态判定失败）: ${result.unknownCount}`);
          }
        } finally {
          process.off('SIGINT', onSigInt);
          await adapter.close();
        }
      } finally {
        db.close();
      }
    });

/** 查该 source 下最近一个迁移任务（满足 cleanup_plans.migration_job_id FK）。 */
function resolveLatestMigrationJobId(db: DB, sourceInstanceId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM migration_jobs WHERE source_instance_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceInstanceId) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error('没有可关联的迁移任务，请先完成迁移再清理');
  }
  return row.id;
}

  return cleanup;
}
