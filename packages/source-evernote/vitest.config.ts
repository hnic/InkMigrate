import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 不自定义 exclude：显式覆盖会替换 vitest 内置默认排除
    // （**/node_modules/**、**/dist/** 等），嵌套目录反而会被误收集
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    // forks 必需（勿"优化"回 threads）：enml-to-html.ts 持有模块级共享
    // JSDOM/DOMPurify 单例，threads 池同 worker 复用模块状态会跨测试文件串扰
    pool: 'forks',
    // 单测默认收紧到 10s 以便尽早暴露挂起（sax 流不 end / promise 不落定）；
    // e2e 迁移测试真实需要数十秒，在测试内显式 opt-in 更大 timeout
    testTimeout: 10_000,
  },
});
