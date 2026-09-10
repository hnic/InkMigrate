import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    exclude: ['tests/browser/**'],
    pool: 'forks',
    // 单元测试默认 5s 超时即可（挂起的异步测试快速失败）；个别慢测试在
    // it(..., { timeout }) 单独设置——浏览器测试由 vitest.browser.config.ts
    // 单独运行并配置更长超时
  },
});
