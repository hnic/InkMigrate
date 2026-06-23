import { describe } from 'vitest';
import { runTargetAdapterContract } from '@inkmigrate/testkit';
import { createObsidianTarget } from '../src/index.js';

// §24.2 目标适配器契约测试。
// createObsidianTarget() 返回的对象已满足 TargetAdapter 形状；
// testkit 套件校验 kind/version/apiVersion 非空且 apiVersion 在核心兼容范围内。
describe('obsidian target contract (§24.2)', () => {
  runTargetAdapterContract(() => createObsidianTarget());
});
