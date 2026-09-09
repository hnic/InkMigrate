import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    // 允许阶段早期在还没有测试文件时通过；产生测试后应移除此开关。
    passWithNoTests: true,
  },
});
