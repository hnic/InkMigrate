/**
 * 进程级取消标志。
 *
 * cancel.cancel RPC 设置后，所有长任务循环（scan/migrate/cleanup）检查它并优雅退出。
 * 这是 RPC 级终止机制（GUI 的"终止"按钮），与 signals.ts 的 SIGINT（CLI 的 Ctrl+C）并存：
 * - SIGINT 有"第二次硬退"风险，不适合 GUI 按钮误触
 * - cancel flag 是幂等的，重复设置无副作用，循环在下一次迭代边界退出
 *
 * 不放进 core 包——这是 engine（sidecar 进程）专属的运行时控制，core 是纯逻辑库。
 */
let cancelled = false;

/** 设置取消标志（由 cancel.cancel RPC 调用）。幂等。 */
export function requestCancel(): void {
  cancelled = true;
}

/** 查询是否已请求取消（由长任务循环每轮迭代检查）。 */
export function isCancelledFlag(): boolean {
  return cancelled;
}

/**
 * 每个长任务开始时重置（确保新任务不继承上次的取消状态）。
 * 由 scan.start / migrate.start / cleanup.unfavorite 的 handler 开头调用。
 */
export function resetCancel(): void {
  cancelled = false;
}
