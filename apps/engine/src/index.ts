#!/usr/bin/env node
/**
 * InkMigrate Engine — Node sidecar 进程。
 *
 * 通过 stdin/stdout 的 JSON-RPC 2.0 协议与 Tauri（或其他宿主）通信。
 * 封装 @inkmigrate/core + source-toutiao + target-obsidian 的全部能力。
 *
 * 协议：
 * - stdin：每行一个 JSON-RPC Request
 * - stdout：每行一个 JSON-RPC Response 或 Notification
 * - stderr：日志输出（不干扰 JSON 通道）
 */
import { registerAllHandlers } from './rpc-handlers.js';
import { startStdinLoop, logToStderr } from './transport.js';
import { getHeapStatistics } from 'node:v8';

function main(): void {
  // 检查堆大小是否足够（全量迁移数千条需要大量内存）
  const heapStats = getHeapStatistics();
  const limitMB = Math.round(heapStats.heap_size_limit / 1024 / 1024);
  if (limitMB < 4096) {
    logToStderr('warn', `堆限制 ${limitMB}MB 偏低，建议用 --max-old-space-size=8192 启动`);
  } else {
    logToStderr('info', `堆限制 ${limitMB}MB`);
  }

  registerAllHandlers();
  startStdinLoop();
  logToStderr('info', 'InkMigrate engine started, waiting for RPC on stdin');
}

main();
