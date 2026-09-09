#!/usr/bin/env node
import { Command } from 'commander';
import { CORE_VERSION } from '@inkmigrate/core';
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`inkmigrate: ${message}`);
  // INKMIGRATE_DEBUG=1 时附带堆栈与 cause 链，便于排查深层 I/O 错误
  if (process.env.INKMIGRATE_DEBUG === '1' && err instanceof Error) {
    console.error(err.stack);
    if ('cause' in err && err.cause !== undefined) {
      console.error('Caused by:', err.cause);
    }
  }
  // 用 exitCode 而非 process.exit：管道输出（如 `inkmigrate ... | tee`）场景下
  // process.exit 会截断尚未写完的 stdout/stderr
  process.exitCode = 1;
});
