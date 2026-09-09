/**
 * 进程级取消标志 + 活跃长任务槽位。
 *
 * job.cancel RPC 设置后，所有长任务循环（scan/migrate/cleanup）检查它并优雅退出。
 * 这是 RPC 级终止机制（GUI 的"终止"按钮），与 signals.ts 的 SIGINT（CLI 的 Ctrl+C）并存：
 * - SIGINT 有"第二次硬退"风险，不适合 GUI 按钮误触
 * - cancel flag 是幂等的，重复设置无副作用，循环在下一次迭代边界退出
 *
 * C10: 此前 cancelled 是单变量，scan.start/migrate.start/cleanup.unfavorite 开头都调
 * resetCancel()。由于 RPC handler 是 fire-and-forget（可并发），一个新任务开头的 resetCancel()
 * 会清掉正在跑的长任务的取消请求 → 用户点了终止、任务永不退出，持续请求触发风控/封号。
 * 现引入"活跃任务"槽位：同一时刻只允许一个长任务运行，重复启动直接拒绝；
 * 取消标志绑定到活跃任务 key，只有该任务自己 reset，不会误清在途任务。
 *
 * 不放进 core 包——这是 engine（sidecar 进程）专属的运行时控制，core 是纯逻辑库。
 */
let cancelled = false;

/** 长任务种类（活跃任务槽位的封闭集合）。 */
export type TaskKind = 'scan' | 'migrate' | 'cleanup';

/** 当前活跃长任务标识，null 表示无活跃任务。 */
let activeTask: TaskKind | null = null;

/**
 * 已有活跃长任务时抛错（拒绝并发启动，避免 resetCancel 互踩取消请求）。
 * 注意：同步抛出——调用方必须处于能接住异常并转为 RPC 错误响应的上下文
 * （transport.handleRequest 的 try/catch），裸调用会变成进程级 unhandled rejection。
 */
export function beginTask(taskKind: TaskKind): void {
  if (activeTask !== null) {
    throw new Error(
      `已有活跃长任务（${activeTask}）正在运行，请先终止或等待完成后再启动 ${taskKind}`,
    );
  }
  activeTask = taskKind;
  cancelled = false;
}

/**
 * 长任务结束时释放槽位（无论成功/失败/取消）。幂等。
 * 调用约定：每个 beginTask 的调用方必须在 finally 中调用 endTask 释放，
 * 遗漏会让槽位永久占用（此后所有长任务都被拒绝，直到 sidecar 重启）。
 * 传入 taskKind 时只释放自己占用的槽位：迟到的 endTask（上一任务残留的
 * 异步清理）不会误清新任务的槽位/取消标志。
 */
export function endTask(taskKind?: TaskKind): void {
  if (taskKind !== undefined && activeTask !== taskKind) return; // 不是自己的槽位，不动
  activeTask = null;
  cancelled = false; // 标志随槽位一起复位，避免空闲期残留 true 误导状态查询
}

/** 查询当前活跃任务（供 status / UI 显示）。 */
export function getActiveTask(): TaskKind | null {
  return activeTask;
}

/** 设置取消标志（由 job.cancel RPC 调用）。幂等。 */
export function requestCancel(): void {
  cancelled = true;
}

/** 查询是否已请求取消（由长任务循环每轮迭代检查）。 */
export function isCancelledFlag(): boolean {
  return cancelled;
}
