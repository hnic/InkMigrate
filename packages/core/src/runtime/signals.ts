/**
 * §18.3 `Ctrl+C`（SIGINT）/ SIGTERM 处理。
 *
 * 第一次中断：核心停止领取新任务、完成当前数据库事务、把未完成条目标记为
 * `interrupted`、安全关闭浏览器与数据库。本函数只提供"第一次软退 + 第二次
 * 硬退"的两阶段框架；具体清理动作由调用方注入。
 *
 * 第二次中断：直接强制退出。第二次中断不会等待第一次的清理完成。
 */
export interface GracefulShutdownHandlers {
  /** 第一次中断时执行（典型：保存悬挂状态、关闭 DB/浏览器）。失败会被吞掉。 */
  onFirstInterrupt: () => Promise<void>;
  /** 第二次中断时执行（典型：process.exit 或抛出）。 */
  onSecondInterrupt: () => void;
}

export function installSignalHandlers(
  h: GracefulShutdownHandlers,
): () => void {
  let interrupted = false;
  let exiting = false;

  const onInt = (): void => {
    if (exiting) {
      // 已进入强制退出路径：忽略后续信号。onSecondInterrupt 未必同步终止进程
      //（异步 exit / 仅记录日志），若不加此守卫，第三个信号会落到下方分支
      // 再次触发第一次清理，重复执行可能仍在进行的 DB/浏览器收尾。
      return;
    }
    if (interrupted) {
      // 第二次中断：不再走软退，直接强制。
      exiting = true;
      h.onSecondInterrupt();
      return;
    }
    interrupted = true;
    // 第一次：异步清理；失败属于退出路径，吞掉错误但留痕（stderr），
    // 否则 DB flush / 浏览器关闭失败完全不可诊断。同步抛出同样属于退出路径。
    try {
      h.onFirstInterrupt().catch((err: unknown) => {
        /* shutdown path: swallow */
        console.error('[signals] graceful shutdown failed:', err);
      });
    } catch (err: unknown) {
      /* shutdown path: swallow */
      console.error('[signals] graceful shutdown threw synchronously:', err);
    }
  };

  process.on('SIGINT', onInt);
  process.on('SIGTERM', onInt);

  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onInt);
  };
}
