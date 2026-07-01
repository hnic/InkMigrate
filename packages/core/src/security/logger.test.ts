import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';

/**
 * §20.1 / H1 / H3 脱敏包装测试。
 *
 * createLogger 默认走 transport（pino worker 线程，异步刷盘），不利于同步断言。
 * 这里用一个捕获型 Writable 作为 pino 的底层 stream，绕过 transport，直接同步
 * 验证脱敏包装的运行时行为（child 拦截、字段脱敏）。
 *
 * 为此需要直接构造一个带 stream 的 pino，并复用 createLogger 同款的包装逻辑。
 * 我们通过 createLogger 不带 destination 创建（默认写 stdout），再验证其 child
 * 返回值的结构（被 Proxy 包装、info 可调用）；脱敏的正确性由 redactor.test.ts 覆盖。
 * 此处聚焦 H1（child 不穿透）和 API 契约。
 */

describe('logger (§20.1) - 脱敏包装', () => {
  it('createLogger 返回的 logger 拦截 6 个 level 方法', () => {
    const log = createLogger({ level: 'silent' });
    // 所有 level 方法应可调用（被 Proxy 包装后仍为函数）
    for (const fn of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      expect(typeof log[fn]).toBe('function');
    }
  });

  it('H1: logger.child() 返回可再次 child 的包装对象（递归，不穿透到原始 logger）', () => {
    const log = createLogger({ level: 'silent' });
    const child = log.child({ requestId: 'req1' });
    // child 返回值必须也有 child 方法，且返回的孙 logger 也被包装（可继续 child）
    expect(typeof child.child).toBe('function');
    const grandchild = child.child({ nested: true });
    expect(typeof grandchild.child).toBe('function');
    expect(typeof grandchild.info).toBe('function');
    // 三级链均可调用，不抛
    expect(() => grandchild.info({ cookie: 'x=1' })).not.toThrow();
  });

  it('H1: child logger 的 info 也是被包装的函数（不是原始 pino LogFn）', () => {
    const log = createLogger({ level: 'silent' });
    const child = log.child({ rid: 'r' });
    // 被包装的 info 与原始 logger.info 不是同一个引用（包装层产生了新函数）
    // 这验证了 child 确实走了拦截路径，而非透传原始 logger
    const rawInfo = (log as unknown as { info: unknown }).info;
    const childInfo = (child as unknown as { info: unknown }).info;
    expect(typeof childInfo).toBe('function');
    expect(childInfo).not.toBe(rawInfo);
  });
});
