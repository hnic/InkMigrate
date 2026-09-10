#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { CORE_VERSION, createRedactor } from '@inkmigrate/core';
import { createAuthCommand } from './commands/auth.js';
import { createInitCommand } from './commands/init.js';
import { createConfigCommand } from './commands/config.js';
import { createSourceCommand } from './commands/source.js';
import { createTargetCommand } from './commands/target.js';
import { createScanCommand } from './commands/scan.js';
import { createMigrateCommand } from './commands/migrate.js';
import { createResumeCommand } from './commands/resume.js';
import { createStatusCommand } from './commands/status.js';
import { createReportCommand } from './commands/report.js';
import { createDiagnosticsCommand } from './commands/diagnostics.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createCleanupCommand } from './commands/cleanup.js';
import { errorMessage } from './util.js';

const program = new Command();

program
  .name('inkmigrate')
  .description(
    'InkMigrate（墨迁）— 本地优先、可验证、可恢复、可审计的知识迁移工具包',
  )
  // 版本与 @inkmigrate/core 保持一致（monorepo 各包同步发布，不单独版本化）
  .version(CORE_VERSION);

program.addCommand(createAuthCommand());
program.addCommand(createInitCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSourceCommand());
program.addCommand(createTargetCommand());
program.addCommand(createScanCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createResumeCommand());
program.addCommand(createStatusCommand());
program.addCommand(createReportCommand());
program.addCommand(createDiagnosticsCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createCleanupCommand());

// 顶层错误统一脱敏（§19.2）：auth/config/HTTP 失败的错误消息常内嵌 token、
// Authorization 头或凭据文本，管道到 tee/CI 日志会持久泄漏——core 的 logger
// 全量走 redactor，这里作为唯一漏斗不得绕过
const redactor = createRedactor();

// commander 对未知命令/选项、--help、--version 默认直接 process.exit：既绕过
// 下方统一 catch（管道输出可能被截断），也令 INKMIGRATE_DEBUG 诊断失效。
// exitOverride 改为抛出让所有失败路径走同一个 catch。注意 addCommand 不像
// .command() 那样 copyInheritedSettings，需递归遍历各级子命令逐个设置。
const rethrow = (e: CommanderError): never => {
  throw e;
};
const overrideExit = (cmd: Command): void => {
  cmd.exitOverride(rethrow);
  cmd.commands.forEach(overrideExit);
};
overrideExit(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // --help/--version：commander 已打印输出（exitCode=0），干净退出即可
  if (err instanceof CommanderError && err.exitCode === 0) {
    process.exitCode = 0;
    return;
  }
  if (!(err instanceof CommanderError)) {
    // commander 自身错误（未知命令/选项、缺参）已由其打印，不重复输出
    console.error(`inkmigrate: ${redactor(errorMessage(err))}`);
    // INKMIGRATE_DEBUG=1 时附带堆栈与 cause 链，便于排查深层 I/O 错误
    if (process.env.INKMIGRATE_DEBUG === '1' && err instanceof Error) {
      console.error(redactor(err.stack ?? ''));
      // 逐层解包 cause（带上限防环）：fetch/fs 深层错误常嵌套多层，只解一层
      // 会把根因藏起来；每层都过 redactor，非 Error 值也 String 化后脱敏
      let cause: unknown = (err as Error & { cause?: unknown }).cause;
      for (let depth = 0; cause !== undefined && depth < 10; depth += 1) {
        console.error(
          'Caused by:',
          cause instanceof Error
            ? redactor(cause.stack ?? cause.message)
            : redactor(String(cause)),
        );
        cause =
          cause instanceof Error
            ? (cause as Error & { cause?: unknown }).cause
            : undefined;
      }
    }
  }
  // 用 exitCode 而非 process.exit：管道输出（如 `inkmigrate ... | tee`）场景下
  // process.exit 会截断尚未写完的 stdout/stderr
  process.exitCode = err instanceof CommanderError ? err.exitCode : 1;
});
