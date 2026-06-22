import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    // 允许阶段早期在还没有测试文件时通过；后续阶段产生测试后依然有效。
    passWithNoTests: true,
  },
});
