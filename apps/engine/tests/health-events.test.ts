import { describe, it, expect, vi } from 'vitest';
import { createUncaughtExceptionHandler } from '../src/health-events.js';

describe('handleUncaughtException (health_degraded)', () => {
  it('首条异常发送 health_degraded notification', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    handler(new Error('boom'));

    expect(logToStderr).toHaveBeenCalledWith('error', expect.stringContaining('boom'));
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith('health_degraded', {
      reason: 'uncaughtException',
      message: 'boom',
      stack: expect.any(String),
    });
  });

  it('后续异常不再发 notification（单次节流），但仍写 stderr', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    handler(new Error('first'));
    handler(new Error('second'));
    handler(new Error('third'));

    expect(sendNotification).toHaveBeenCalledTimes(1); // 只发首条
    expect(logToStderr).toHaveBeenCalledTimes(3); // 每条都记 stderr
  });

  it('无 stack 时 payload 不含 stack 字段', () => {
    const sendNotification = vi.fn();
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    const err = new Error('no stack');
    err.stack = undefined;
    handler(err);

    expect(sendNotification).toHaveBeenCalledWith('health_degraded', {
      reason: 'uncaughtException',
      message: 'no stack',
    });
  });

  it('sendNotification 自身抛异常时不冒泡（兜底 try/catch）', () => {
    const sendNotification = vi.fn(() => { throw new Error('stdout broken'); });
    const logToStderr = vi.fn();
    const handler = createUncaughtExceptionHandler({ sendNotification, logToStderr });

    expect(() => handler(new Error('boom'))).not.toThrow();
    expect(logToStderr).toHaveBeenCalled();
    expect(logToStderr).toHaveBeenCalledWith('warn', expect.stringContaining('发送失败'));
  });
});
