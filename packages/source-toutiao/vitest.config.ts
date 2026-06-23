import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    passWithNoTests: true,
    // 浏览器/HTTP 测试较慢；给足超时
    testTimeout: 30_000,
  },
});
