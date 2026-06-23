import { Command } from 'commander';
import {
  openDatabase,
  MigrationJobs,
  canResumeFrom,
  type DB,
} from '@inkmigrate/core';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * §22 `inkmigrate resume` 命令。
 *
 * 检查 Job 当前状态，判断是否可以恢复。
 * v1.0-rc1：实现状态检查 + canResumeFrom 判定；
 * 完整 resume-from-current_stage 逻辑在后续完善。
 */
export function createResumeCommand(): Command {
  return new Command('resume')
    .description('恢复暂停或中断的迁移 Job')
    .requiredOption('--job <id>', 'Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      if (!existsSync(dbPath)) {
        console.error(`数据库不存在：${dbPath}`);
        process.exit(1);
      }

      const db: DB = openDatabase({ path: dbPath });
      try {
        const job = new MigrationJobs(db).get(opts.job);
        console.log(`Job ${opts.job}:`);
        console.log(`  当前状态: ${job.status}`);
        console.log(`  当前阶段: ${job.currentStage}`);

        if (canResumeFrom(job.status as 'paused' | 'interrupted' | 'completed' | 'running' | 'created' | 'failed')) {
          console.log(`\n✓ 可以从 ${job.status} 恢复。`);
          if (job.status === 'paused') {
            console.log(`  暂停原因: ${job.pauseReasonCode ?? '未知'}`);
            console.log('  从 paused 恢复时先复核暂停原因是否已解除。');
          } else if (job.status === 'interrupted') {
            console.log('  从 interrupted 恢复时先重检悬挂条目和磁盘状态。');
          }
          console.log('\nStage 4 基础实现：完整 resume-from-current_stage 逻辑在后续完善。');
        } else {
          console.log(`\n✗ 当前状态 ${job.status} 不可恢复。`);
          console.log('  只有 paused 或 interrupted 状态的 Job 可以恢复。');
        }
      } catch {
        console.error(`Job ${opts.job} 不存在`);
        process.exit(1);
      } finally {
        db.close();
      }
    });
}
