import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 不自定义 exclude：显式覆盖会替换 vitest 内置默认排除
    // （**/node_modules/**、**/dist/** 等），嵌套目录反而会被误收集
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
