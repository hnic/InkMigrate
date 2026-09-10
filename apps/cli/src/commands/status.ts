import { Command } from 'commander';
import { openDatabase, MigrationJobs, type DB } from '@inkmigrate/core';
import { join } from 'node:path';
import { DB_FILENAME, errorMessage } from '../util.js';

export function createStatusCommand(): Command {
  return new Command('status')
    .description('显示 Job 状态')
    .requiredOption('--job <id>', 'Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      const dbPath = join(opts.stateDir, DB_FILENAME);
      let db: DB;
      try {
        db = openDatabase({ path: dbPath });
      } catch (e) {
        // L18: 区分「DB 不可读」与「Job 不存在」（原 catch 混淆两者）。
        console.error(`无法打开数据库 ${dbPath}：${errorMessage(e)}`);
        process.exitCode = 1;
        return;
      }
      try {
        const job = new MigrationJobs(db).get(opts.job);
        if (job === undefined) {
          console.error(`Job ${opts.job} 不存在`);
          process.exitCode = 1;
          return;
        }
        console.log(`Job ${opts.job}:`);
        console.log(`  status: ${job.status}`);
        console.log(`  current_stage: ${job.currentStage}`);
        console.log(`  scan_count: ${job.scanCount}`);
        console.log(`  verified: ${job.verifiedCount}`);
        console.log(`  degraded: ${job.degradedCount}`);
        console.log(`  failed: ${job.failedCount}`);
        console.log(`  conflict: ${job.conflictCount}`);
        console.log(`  skipped: ${job.skippedCount}`);
      } catch (e) {
        console.error(`读取 Job ${opts.job} 失败：${errorMessage(e)}`);
        process.exitCode = 1;
      } finally {
        // 无论成败都关库，避免读取异常时泄漏连接（WAL 未 checkpoint）
        try {
          db.close();
        } catch (e) {
          // close 自身失败（如 WAL checkpoint 撞 SQLITE_BUSY）不应让已成功的
          // 输出被顶层 catch 改判为失败命令；如实提示并置非零退出码
          console.error(`关闭数据库 ${dbPath} 失败：${errorMessage(e)}`);
          process.exitCode = 1;
        }
      }
    });
}
