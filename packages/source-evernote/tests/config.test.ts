import { describe, it, expect } from 'vitest';
import { EvernoteSourceConfigSchema } from '../src/config.js';

// 钉住用户可见的默认值：d8c3f7b 引入 notebookShortId 时按 PRD 设为 true，
// 与同批「笔记本目录去短 ID」的用户需求相悖（同类的 filenameShortId 已于
// 2026-09-11 翻回 false，c14443e）。此默认翻转过一次，钉住防止回退。
describe('EvernoteSourceConfigSchema 默认值', () => {
  it('notebookShortId 默认 false（笔记本目录用纯名称）', () => {
    const cfg = EvernoteSourceConfigSchema.parse({
      sourceInstanceId: 'evernote-main',
      inputPaths: ['/fixtures'],
    });
    expect(cfg.notebookShortId).toBe(false);
  });
});
