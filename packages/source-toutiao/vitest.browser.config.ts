import { defineConfig } from 'vitest/config';

// 浏览器测试需要更长超时（启动 Chromium + 导航 + 滚动）；CI 冷启动 + 反爬
// 慢响应可用 BROWSER_TEST_TIMEOUT_MS 调大而无需改代码
const browserTestTimeout = Number(process.env.BROWSER_TEST_TIMEOUT_MS) || 60_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser/**/*.test.ts'],
    pool: 'forks',
    // CI 下禁止 0 测试静默通过（include 失配/文件被移动会假绿）；仅本地容忍空跑
    passWithNoTests: process.env.CI !== 'true',
    testTimeout: browserTestTimeout,
    hookTimeout: browserTestTimeout,
  },
});
