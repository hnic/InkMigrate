import { Command } from 'commander';
import { openDatabase, MigrationJobs } from '@inkmigrate/core';
import { join } from 'node:path';

export function createStatusCommand(): Command {
  return new Command('status')
    .description('显示 Job 状态')
    .requiredOption('--job <id>', 'Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
      try {
        const db = openDatabase({ path: dbPath });
        const job = new MigrationJobs(db).get(opts.job);
        db.close();
        console.log(`Job ${opts.job}:`);
        console.log(`  status: ${job.status}`);
        console.log(`  current_stage: ${job.currentStage}`);
        console.log(`  scan_count: ${job.scanCount}`);
        console.log(`  verified: ${job.verifiedCount}`);
        console.log(`  degraded: ${job.degradedCount}`);
        console.log(`  failed: ${job.failedCount}`);
        console.log(`  conflict: ${job.conflictCount}`);
        console.log(`  skipped: ${job.skippedCount}`);
      } catch {
        console.error(`无法读取数据库或 Job ${opts.job} 不存在`);
        process.exit(1);
      }
    });
}
