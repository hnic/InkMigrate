import { Command } from 'commander';

export function createResumeCommand(): Command {
  return new Command('resume')
    .description('恢复暂停或中断的迁移 Job')
    .requiredOption('--job <id>', 'Job ID')
    .requiredOption('--state-dir <path>', 'workspace stateDir')
    .action((opts: { job: string; stateDir: string }) => {
      console.log(
        `Stage 4 占位：将恢复 Job ${opts.job}（stateDir=${opts.stateDir}）`,
      );
      console.log('从 paused 恢复时先复核暂停原因；从 interrupted 恢复时重检悬挂状态。');
    });
}
