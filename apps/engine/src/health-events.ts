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
  /**
   * 必须为同步实现：TS 的返回类型拦不住 async 函数，若返回 Promise，
   * 其 rejection 会逃逸出 handler 内的 try/catch（成为 unhandledRejection）。
   * 返回值表示是否实际送达：false = transport 静默丢弃（背压/管道断开等
   * 不抛出的丢弃路径），调用方据此保留重试机会。
   */
  sendNotification: (method: string, params?: Record<string, unknown>) => boolean;
  logToStderr: (level: string, message: string) => void;
}

export function createUncaughtExceptionHandler(deps: HandlerDeps) {
  let healthDegradedSent = false;

  return function handleUncaughtException(thrown: unknown): void {
    // 'uncaughtException' 也可能送达非 Error 值（throw 'boom' / Promise.reject(null)）：
    // 先规范化——对 null 取 .message 会在 handler 内二次抛出（uncaughtException handler
    // 内抛异常是致命的），字符串则会让 message 静默退化成 undefined。
    let err: Error;
    if (thrown instanceof Error) {
      err = thrown;
    } else {
      try {
        err = new Error(String(thrown));
      } catch {
        // String() 自身抛出（toString/valueOf 抛异常的怪异对象 / 恶意 Proxy）：
        // 规范化绝不能让 handler 二次抛出（致命），退化为仅含类型信息的兜底描述。
        err = new Error(`non-Error thrown (typeof ${typeof thrown})`);
      }
    }

    try {
      deps.logToStderr('error', `未捕获异常（已恢复，sidecar 继续运行）：${err.message}\n${err.stack ?? ''}`);
    } catch {
      // stderr 写入失败（管道 EPIPE 等）：吞掉，handler 自身绝不二次抛出。
    }

    if (healthDegradedSent) return; // 单次节流

    const payload = {
      reason: 'uncaughtException',
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    } satisfies HealthDegradedNotification;
    try {
      const delivered = deps.sendNotification('health_degraded', payload);
      // 实际送达才置位：不抛出 ≠ 送达——transport.writeLine 在背压/管道断开路径
      // 会静默丢弃（返回 false）。未送达时保留重试机会，在下次异常再试一次——
      // 提前置位会让降级通知永久丢失。
      if (delivered) healthDegradedSent = true;
    } catch {
      // 兜底：sendNotification 自身失败（stdout 已断等）不应让 handler 二次崩溃。
      // writeLine 内部已有 try/catch，此处为防御性双保险。
      try {
        deps.logToStderr('warn', 'health_degraded notification 发送失败，已忽略');
      } catch {
        // 同上：handler 绝不二次抛出。
      }
    }
  };
}
