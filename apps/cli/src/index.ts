#!/usr/bin/env node
import { Command } from 'commander';
import { CORE_VERSION } from '@inkmigrate/core';
import { createAuthCommand } from './commands/auth.js';

const program = new Command();

program
  .name('inkmigrate')
  .description(
    'InkMigrate（墨迁）— 本地优先、可验证、可恢复、可审计的知识迁移工具包',
  )
  .version(CORE_VERSION);

// auth 子命令（§12.2）在阶段 3 注册；其余子命令在后续阶段加入。
program.addCommand(createAuthCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
