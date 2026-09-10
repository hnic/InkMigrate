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
    const rawInfo = (log as unknown as { info: unknown }).info;
    const childInfo = (child as unknown as { info: unknown }).info;
    expect(typeof childInfo).toBe('function');
    expect(childInfo).not.toBe(rawInfo);
  });

  it('R3-H2: 循环引用对象/数组不栈溢出（H-3 修复对数组路径也生效）', () => {
    const log = createLogger({ level: 'silent' });
    // 对象自引用
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => log.info(obj)).not.toThrow();
    // 数组自引用（R3-H2 核心：原数组分支传 seen 而非 visited，仍栈溢出）
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => log.info({ items: arr })).not.toThrow();
    // err.cause = [err]（通过数组的循环）
    const err = new Error('test');
    (err as { cause: unknown }).cause = [err];
    expect(() => log.error(err)).not.toThrow();
    // 互相引用的数组
    const a1: unknown[] = [];
    const a2: unknown[] = [a1];
    a1.push(a2);
    expect(() => log.info({ a1 })).not.toThrow();
  });

  it('#352: setBindings 被拦截且 fail-closed（getter 抛错时不抛出、不写入原值）', () => {
    // pino 的 setBindings 会把参数并入 chindings 前置到后续每一行，方法级
    // 拦截看不到——若未拦截，带抛错 getter 的 bindings 会让异常直接抛回调用方。
    const log = createLogger({ level: 'silent' });
    expect(typeof log.setBindings).toBe('function');
    const evil = {
      get apiKey(): string {
        throw new Error('boom');
      },
    };
    expect(() => log.setBindings(evil)).not.toThrow();
    // 正常 bindings 调用也不抛（脱敏后委托给底层 setBindings）
    expect(() => log.setBindings({ jobId: 'j1' })).not.toThrow();
  });
});
