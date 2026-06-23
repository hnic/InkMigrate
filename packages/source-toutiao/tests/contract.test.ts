import { describe } from 'vitest';
import { runSourceAdapterContract } from '@inkmigrate/testkit';
import { createToutiaoSource } from '../src/index.js';

// §24.2 来源适配器契约测试。
describe('toutiao source contract (§24.2)', () => {
  runSourceAdapterContract(() => createToutiaoSource());
});
