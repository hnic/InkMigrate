#!/usr/bin/env node
import { Command } from 'commander';
import { CORE_VERSION } from '@inkmigrate/core';

const program = new Command();

program
  .name('inkmigrate')
  .description(
    'InkMigrate（墨迁）— 本地优先、可验证、可恢复、可审计的知识迁移工具包',
  )
  .version(CORE_VERSION);

// 阶段 1 暂不注册业务子命令；阶段 2-6 起逐步加入
// init / source / target / auth / scan / migrate / resume / verify / status /
// report / conflict / cleanup / diagnostics / doctor / config。

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
