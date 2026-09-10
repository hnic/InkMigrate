import { describe, it, expect } from 'vitest';
import { ToutiaoSourceConfigSchema } from '../src/config.js';

// 钉住用户可见的默认值：1d5b714 将单图上限提为 150MB（高分辨率长图/GIF），
// 98b319f 重构对齐 schema 时被静默回退为 50MB——默认值回归过一次，值得钉死。
describe('ToutiaoSourceConfigSchema 默认值', () => {
  it('maxImageBytes 默认 150MB', () => {
    expect(ToutiaoSourceConfigSchema.shape.maxImageBytes.parse(undefined)).toBe(
      150 * 1024 * 1024,
    );
  });
});
