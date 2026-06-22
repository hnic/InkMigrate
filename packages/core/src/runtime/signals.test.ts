import { describe, it, expect, vi } from 'vitest';
import { installSignalHandlers } from './signals.js';

describe('installSignalHandlers (§18.3)', () => {
  it('onFirstInterrupt fires once on first SIGINT, onSecondInterrupt on second', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn();
    const uninstall = installSignalHandlers({
      onFirstInterrupt: first,
      onSecondInterrupt: second,
    });
    try {
      process.emit('SIGINT', 'SIGINT');
      // await the async handler
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();

      process.emit('SIGINT', 'SIGINT');
      await new Promise((r) => setImmediate(r));
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it('uninstall removes the listeners', async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn();
    const uninstall = installSignalHandlers({
      onFirstInterrupt: first,
      onSecondInterrupt: second,
    });
    uninstall();
    const before = process.listenerCount('SIGINT');
    process.emit('SIGINT', 'SIGINT');
    await new Promise((r) => setImmediate(r));
    expect(first).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('first handler errors are swallowed (shutdown path)', async () => {
    const first = vi.fn().mockRejectedValue(new Error('boom'));
    const second = vi.fn();
    const uninstall = installSignalHandlers({
      onFirstInterrupt: first,
      onSecondInterrupt: second,
    });
    try {
      process.emit('SIGINT', 'SIGINT');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(first).toHaveBeenCalled();
      // second still works after a failed first
      process.emit('SIGINT', 'SIGINT');
      await new Promise((r) => setImmediate(r));
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });
});
