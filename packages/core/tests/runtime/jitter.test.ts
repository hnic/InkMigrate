import { describe, it, expect } from 'vitest';
import {
  withJitter,
  ITEM_INTERVAL_JITTER,
  RETRY_BACKOFF_JITTER,
} from '../../src/runtime/jitter.js';

describe('withJitter (§18.1 防风控抖动)', () => {
  it('jitterRatio=0 时恒等于 base', () => {
    // 任意随机源都不影响，factor 恒为 1
    expect(withJitter(1500, 0, () => 0)).toBe(1500);
    expect(withJitter(1500, 0, () => 0.5)).toBe(1500);
    expect(withJitter(1500, 0, () => 1)).toBe(1500);
  });

  it('base=0 时恒返回 0', () => {
    expect(withJitter(0, 0.4, () => 0.99)).toBe(0);
  });

  it('random=0 时取下界 base×(1-ratio)', () => {
    // factor = 1 + (0*2-1)*ratio = 1-ratio
    expect(withJitter(1000, 0.4, () => 0)).toBe(600);
    expect(withJitter(3000, 0.5, () => 0)).toBe(1500);
  });

  it('random=1 时取上界 base×(1+ratio)', () => {
    // factor = 1 + (1*2-1)*ratio = 1+ratio
    expect(withJitter(1000, 0.4, () => 1)).toBe(1400);
    expect(withJitter(3000, 0.5, () => 1)).toBe(4500);
  });

  it('random=0.5 时取中值（factor=1，不抖动）', () => {
    expect(withJitter(1500, 0.4, () => 0.5)).toBe(1500);
    expect(withJitter(10000, 0.5, () => 0.5)).toBe(10000);
  });

  it('采样值始终落在 [base×(1-ratio), base×(1+ratio)] 区间内', () => {
    const base = 1500;
    const ratio = ITEM_INTERVAL_JITTER;
    const lo = base * (1 - ratio);
    const hi = base * (1 + ratio);
    // 用多个不同 random 值验证区间不变量
    for (let seed = 0; seed <= 100; seed++) {
      const r = seed / 100;
      const v = withJitter(base, ratio, () => r);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  it('四舍五入为整数毫秒', () => {
    // base=1001 ratio=0.4 random=0.3 → factor=1+(0.6-1)*0.4=0.84 → 840.84 → 841
    expect(withJitter(1001, 0.4, () => 0.3)).toBe(841);
  });

  it('不会返回负数（即使 base×factor 舍入后）', () => {
    // 极端：base=1 ratio=1 random=0 → factor=0 → max(0, 0)=0
    expect(withJitter(1, 1, () => 0)).toBe(0);
  });
});

describe('jitter 常量取值', () => {
  it('条目间隔抖动 ±40%，落在 [0.6×, 1.4×]', () => {
    expect(ITEM_INTERVAL_JITTER).toBe(0.4);
    const base = 1500;
    expect(withJitter(base, ITEM_INTERVAL_JITTER, () => 0)).toBe(900);
    expect(withJitter(base, ITEM_INTERVAL_JITTER, () => 1)).toBe(2100);
  });

  it('重试退避抖动 ±50%，落在 [0.5×, 1.5×]', () => {
    expect(RETRY_BACKOFF_JITTER).toBe(0.5);
    const base = 3000;
    expect(withJitter(base, RETRY_BACKOFF_JITTER, () => 0)).toBe(1500);
    expect(withJitter(base, RETRY_BACKOFF_JITTER, () => 1)).toBe(4500);
  });
});
