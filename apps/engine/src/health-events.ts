import type { HealthDegradedNotification } from '@inkmigrate/protocol';

/**
 * uncaughtException 的降级通知处理器（可测纯函数）。
 *
 * 设计见 docs/2026-07-24-engine-health-degraded-design.md：
 * - 单次通知节流（进程级标志）：首条异常发 health_degraded，后续只写 stderr。
 * - sendNotification 包 try/catch：防止"处理异常的代码本身抛异常"二次崩溃。
 *
 * 通过 createUncaughtExceptionHandler 注入 sendNotification/logToStderr，
 * 使其与 transport 模块解耦，可在单测中 mock。
 */
export interface HandlerDeps {
  sendNotification: (method: string, params?: Record<string, unknown>) => void;
  logToStderr: (level: string, message: string) => void;
}

export function createUncaughtExceptionHandler(deps: HandlerDeps) {
  let healthDegradedSent = false;

  return function handleUncaughtException(err: Error): void {
    deps.logToStderr('error', `未捕获异常（已恢复，sidecar 继续运行）：${err.message}\n${err.stack ?? ''}`);

    if (healthDegradedSent) return; // 单次节流
    healthDegradedSent = true;

    const payload = {
      reason: 'uncaughtException',
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    } satisfies HealthDegradedNotification;
    try {
      deps.sendNotification('health_degraded', payload);
    } catch {
      // 兜底：sendNotification 自身失败（stdout 已断等）不应让 handler 二次崩溃。
      // writeLine 内部已有 try/catch，此处为防御性双保险。
      deps.logToStderr('warn', 'health_degraded notification 发送失败，已忽略');
    }
  };
}
