import { Command } from 'commander';
import {
  openDatabase,
  getCurrentSchemaVersion,
  SCHEMA_VERSION,
} from '@inkmigrate/core';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILENAME, errorMessage } from '../util.js';

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('检查 InkMigrate 环境健康状态')
    .option('--state-dir <path>', 'workspace stateDir')
    .option('--database', '只检查数据库（schema 版本与完整性），跳过磁盘空间检查')
    .action((opts: { stateDir?: string; database?: boolean }) => {
      console.log('InkMigrate Doctor');
      console.log('================\n');

      // 任一检查失败时以非零退出码结束，供脚本/CI 判定工作区不健康
      let healthy = true;

      if (opts.stateDir) {
        const dbPath = join(opts.stateDir, DB_FILENAME);
        if (existsSync(dbPath)) {
          try {
            // 诊断命令不应修改用户数据库：openDatabase 默认会写 WAL 并自动迁移
            // schema，这里用只读连接检查。schema 落后于当前版本时只读打开会抛
            // SQLITE_READONLY，据此如实提示需以可写方式完成自动迁移。
            const db = openDatabase({
              path: dbPath,
              wal: false,
              options: { readonly: true },
            });
            try {
              const version = getCurrentSchemaVersion(db);
              // 显式比对而非依赖 openDatabase 的隐式不变式（只读连接遇 schema
              // 落后会因迁移 DDL 抛 SQLITE_READONLY）：core 若引入只读快路径，
              // 落后版本也不应被报成 ✓
              if (version !== SCHEMA_VERSION) {
                healthy = false;
                console.log(
                  `✗ 数据库 schema 版本不匹配：${version}（期望 ${SCHEMA_VERSION}）：${dbPath}`,
                );
              } else {
                console.log(`✓ 数据库：${dbPath}`);
                console.log(`  Schema 版本：${version}（期望 ${SCHEMA_VERSION}）`);
                if (opts.database) {
                  // --database 承诺的完整性检查：quick_check 只读连接即可执行
                  //（全库扫描，仅在显式要求时做）
                  const integrity = db.pragma('quick_check', {
                    simple: true,
                  }) as string;
                  if (integrity !== 'ok') {
                    healthy = false;
                    console.log(`✗ 数据库完整性检查未通过：${integrity}：${dbPath}`);
                  } else {
                    console.log('  完整性检查: ok');
                  }
                }
              }
            } finally {
              db.close();
            }
          } catch (e) {
            healthy = false;
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'SQLITE_READONLY') {
              console.log(`✗ 数据库 schema 落后，需以可写方式打开一次完成自动迁移：${dbPath}`);
            } else if (
              code?.startsWith('SQLITE_READONLY') ||
              code?.startsWith('SQLITE_CANTOPEN')
            ) {
              // 扩展码如 SQLITE_READONLY_RECOVERY / SQLITE_CANTOPEN_DIRTYWAL：
              // 上次崩溃遗留的 WAL 日志只读连接无法恢复，同样需一次可写打开
              console.log(`✗ 数据库存在待恢复的 WAL 日志，需以可写方式打开一次：${dbPath}`);
            } else {
              console.log(`✗ 数据库检查失败：${errorMessage(e)}`);
            }
          }
        } else {
          console.log(`○ 数据库不存在：${dbPath}`);
        }

        // --database：只检查数据库（schema 版本与完整性），跳过磁盘空间检查
        if (!opts.database) {
          try {
            const stats = statfsSync(opts.stateDir);
            const availGB = (stats.bavail * stats.bsize) / 1024 ** 3;
            console.log(`✓ 磁盘可用空间：${availGB.toFixed(1)} GB`);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'ENOSYS' || code === 'EINVAL') {
              console.log('○ 磁盘空间检查跳过（平台不支持）');
            } else if (code === 'ENOENT') {
              // stateDir 本身不存在（如 init 未运行）：DB 缺失是中性 ○，目录
              // 缺失若归因"磁盘空间检查失败"会误导排查，单独提示
              healthy = false;
              console.log(`✗ 工作区目录不存在：${opts.stateDir}`);
            } else {
              // 无权限（EACCES）等如实报告，而非一律归因"平台不支持"
              healthy = false;
              console.log(`✗ 磁盘空间检查失败：${errorMessage(e)}`);
            }
          }
        }
      } else {
        console.log('使用 --state-dir <path> 检查指定工作区。');
      }

      if (!healthy) process.exitCode = 1;
    });
}
