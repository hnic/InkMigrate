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

function main(): void {
  registerAllHandlers();
  startStdinLoop();
  logToStderr('info', 'InkMigrate engine started, waiting for RPC on stdin');
}

main();
