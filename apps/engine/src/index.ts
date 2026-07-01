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
  // I26: 长驻 sidecar 进程必须有兜底，否则任何 handler 外的异步 reject
  //（listen 失败、心跳回调异常、动态 import 失败）会让整进程崩溃，粒度过粗。
  // 这里只记录到 stderr 并继续运行，让宿主通过日志发现问题而非"整进程消失"。
  process.on('unhandledRejection', (reason) => {
    logToStderr('error', `未处理的 Promise 拒绝：${String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    // M-10: L12 改为 exit(1) 但 Tauri sidecar 无重启机制 → 一次未捕获异常永久杀死
    // sidecar，所有后续 RPC 失败。回退到记录后继续运行（与 unhandledRejection 一致）。
    // Node 官方警告 uncaughtException 后状态可能损坏，但 sidecar 死亡比状态不确定
    // 更糟（用户必须重启整个应用）。日志记录让问题可诊断。
    logToStderr('error', `未捕获异常（已恢复，sidecar 继续运行）：${err.message}\n${err.stack ?? ''}`);
  });

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
