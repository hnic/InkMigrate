import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    pool: 'forks',
    // 已有 tests/smoke.test.ts：零收集即失败（include 拼写错误不会静默通过）
  },
});
