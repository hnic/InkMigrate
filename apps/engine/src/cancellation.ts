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
 * 槽位以世代 token 标识——只有持有 token 的任务能释放槽位/复位标志，
 * 迟到的释放不会误清在途任务。
 *
 * 不放进 core 包——这是 engine（sidecar 进程）专属的运行时控制，core 是纯逻辑库。
 */
let cancelled = false;

/** 长任务种类（活跃任务槽位的封闭集合）。 */
export type TaskKind = 'scan' | 'migrate' | 'cleanup';

/** 当前活跃长任务标识，null 表示无活跃任务。 */
let activeTask: TaskKind | null = null;

/**
 * 槽位世代号：beginTask 发放全局唯一 token，endTask 凭 token 释放。
 * TaskKind 只有 3 个取值，按种类匹配无法区分"同种类的上一次任务"——上一任务
 * 残留的迟到 endTask 会撞上新任务的种类；token 单调递增永不重复，必然对不上。
 */
let generation = 0;
let activeToken = -1;

/**
 * 已有活跃长任务时抛错（拒绝并发启动，避免 resetCancel 互踩取消请求）。
 * 注意：同步抛出——调用方必须处于能接住异常并转为 RPC 错误响应的上下文
 * （transport.handleRequest 的 try/catch），裸调用会变成进程级 unhandled rejection。
 * 返回本次任务的槽位 token，调用方必须在 finally 中传给 endTask 释放。
 */
export function beginTask(taskKind: TaskKind): number {
  if (activeTask !== null) {
    throw new Error(
      `已有活跃长任务（${activeTask}）正在运行，请先终止或等待完成后再启动 ${taskKind}`,
    );
  }
  activeTask = taskKind;
  activeToken = ++generation;
  cancelled = false;
  return activeToken;
}

/**
 * 长任务结束时释放槽位（无论成功/失败/取消）。幂等。
 * 调用约定：必须在 finally 中用 beginTask 返回的 token 调用——token 必填使
 * 配对遗漏在编译期即暴露；遗漏释放会让槽位永久占用（此后所有长任务都被
 * 拒绝，直到 sidecar 重启）。
 * 只释放自己那次占用的槽位：token 不匹配（上一任务残留的迟到 endTask /
 * 重复释放）时不动，不会误清新任务的槽位/取消标志。
 */
export function endTask(token: number): void {
  if (activeTask === null || token !== activeToken) return; // 不是自己那次占用的槽位，不动
  activeTask = null;
  activeToken = -1;
  cancelled = false; // 标志随槽位一起复位，避免空闲期残留 true 误导状态查询
}

/** 查询当前活跃任务（供 status / UI 显示）。 */
export function getActiveTask(): TaskKind | null {
  return activeTask;
}

/**
 * 设置取消标志（由 job.cancel RPC 调用）。幂等。
 * 空闲期（无活跃任务）取消无处生效，直接忽略、不残留标志——下一次
 * beginTask 也会复位 cancelled，此处是"标志绑定活跃任务"的自洽双保险。
 */
export function requestCancel(): void {
  if (activeTask === null) return;
  cancelled = true;
}

/** 查询是否已请求取消（由长任务循环每轮迭代检查）。 */
export function isCancelledFlag(): boolean {
  return cancelled;
}
