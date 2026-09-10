import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 同时覆盖 .spec 命名变体：只匹配 .test.ts 时，新增 .spec.ts 测试文件会被
    // 静默排除在运行之外，CI 给出虚假的全绿
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    pool: 'forks',
  },
});
