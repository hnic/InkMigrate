import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // forks：每个测试文件在独立子进程中运行——本包测试大量操作真实临时目录
    // 与文件系统（原子写入、Vault fixture），进程级隔离避免状态串扰；勿改回 threads。
    pool: 'forks',
  },
});
