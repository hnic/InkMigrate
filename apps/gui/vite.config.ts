/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 忽略 src-tauri（含 cargo target/ 产物），避免 Rust 重编译触发前端整页刷新
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/src-tauri/**', '**/dist/**'],
  },
  // 只暴露 Tauri CLI 注入的 TAURI_ENV_* 变量，避免其他 TAURI_ 前缀值（如密钥）被打进产物
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // 对齐 Tauri 官方脚手架：系统 WebView 可能较旧（macOS Safari 13 / Windows chrome105），
    // esnext 会在这些运行时直接语法报错白屏
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: 'esbuild',
    sourcemap: false,
  },
});
