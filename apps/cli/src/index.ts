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

const program = new Command();

program
  .name('inkmigrate')
  .description(
    'InkMigrate（墨迁）— 本地优先、可验证、可恢复、可审计的知识迁移工具包',
  )
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
