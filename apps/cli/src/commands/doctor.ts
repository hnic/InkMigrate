import { Command } from 'commander';
import {
  openDatabase,
  getCurrentSchemaVersion,
  SCHEMA_VERSION,
} from '@inkmigrate/core';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('检查 InkMigrate 环境健康状态')
    .option('--state-dir <path>', 'workspace stateDir')
    .option('--database', '只检查数据库完整性')
    .action((opts: { stateDir?: string; database?: boolean }) => {
      console.log('InkMigrate Doctor');
      console.log('================\n');

      if (opts.stateDir) {
        const dbPath = join(opts.stateDir, 'inkmigrate.sqlite');
        if (existsSync(dbPath)) {
          try {
            // §缺陷3：openDatabase 打开时会自动 migrate 到最新版本，因此此处
            // 读到的 version 必定等于 SCHEMA_VERSION——原先的 version !==
            // SCHEMA_VERSION 分支是永不可达的死代码。且其提示"请运行
            // inkmigrate config upgrade"误导：config upgrade 升级的是 YAML 配置，
            // 与数据库 schema 无关。这里如实报告版本（已由 openDatabase 自动升级），
            // 不再给无法成立的"版本不一致"提示。
            const db = openDatabase({ path: dbPath });
            const version = getCurrentSchemaVersion(db);
            db.close();
            console.log(`✓ 数据库：${dbPath}`);
            console.log(`  Schema 版本：${version}（期望 ${SCHEMA_VERSION}，已自动迁移）`);
          } catch (e) {
            console.log(`✗ 数据库损坏：${(e as Error).message}`);
          }
        } else {
          console.log(`○ 数据库不存在：${dbPath}`);
        }

        try {
          const stats = statfsSync(opts.stateDir);
          const availGB = (stats.bavail * stats.bsize) / 1024 ** 3;
          console.log(`✓ 磁盘可用空间：${availGB.toFixed(1)} GB`);
        } catch {
          console.log('○ 磁盘空间检查跳过（平台不支持）');
        }
      } else {
        console.log('使用 --state-dir <path> 检查指定工作区。');
      }
    });
}
