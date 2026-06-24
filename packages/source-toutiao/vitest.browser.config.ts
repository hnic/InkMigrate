import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser/**/*.test.ts'],
    pool: 'forks',
    passWithNoTests: true,
    // 浏览器测试需要更长超时（启动 Chromium + 导航 + 滚动）
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
