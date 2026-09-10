import { describe, it, expect } from 'vitest';
import * as core from '../src/index.js';

/**
 * #309 守卫：src/index.ts 大量使用 `export *`，ESM 星号导出语义下同名符号
 * 会被静默丢弃（无编译/运行时错误）。此处按模块断言各自的代表性符号仍然
 * 可见——两个模块未来若发生命名冲突（丢名），对应断言在此失败，而不是
 * 在下游包以 "has no exported member" 的形式暴露。
 */
describe('index barrel (§ 公共 API 面)', () => {
  it('CORE_VERSION 从 package.json 读出且格式合法', () => {
    expect(core.CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('domain 模块的代表性符号未被星号导出冲突丢弃', () => {
    // models / states / errors / stable-keys（capabilities 与 plans 只导出类型，
    // 不产生运行时符号）
    const names = [
      'isSourceContentKind',
      'validateSourceItemQuality',
      'ITEM_FINAL_STATES',
      'isItemFinalState',
      'isItemProcessingState',
      'canJobTransition',
      'verifyCompletionEquation',
      'ERROR_CATEGORIES',
      'toInkMigrateError',
      'ADAPTER_ERROR_DISPOSITION_MISSING',
      'computeStableKey',
      'deriveItemKey',
      'buildInkmigrateId',
    ] as const;
    for (const n of names) {
      expect(core[n], `barrel 应导出 ${n}`).toBeDefined();
    }
  });

  it('adapters / storage / 其余显式导出的代表性符号仍然可见', () => {
    const names = [
      'AdapterRegistry',
      'IncompatibleAdapterApiError',
      'InvalidAdapterApiVersionError',
      'isAdapterApiCompatible',
      'SourceInstances',
      'TargetInstances',
      'MigrationJobs',
      'SourceItems',
      'TargetArtifacts',
      'MigrationAttempts',
      'CleanupPlans',
      'CleanupJobs',
      'CleanupItems',
      'CleanupAttempts',
      'openDatabase',
      'downloadImage',
      'ConfigSchema',
      'loadConfigFromString',
      'writeCsv',
      'sanitizeFilename',
      'runMigrationJob',
      'withJitter',
    ] as const;
    for (const n of names) {
      expect(core[n], `barrel 应导出 ${n}`).toBeDefined();
    }
  });
});
