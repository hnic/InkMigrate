import { describe, it, expect } from 'vitest';
import {
  AuthLoginSchema,
  AuthStatusSchema,
  ScanStartSchema,
  MigrateStartSchema,
  MigrateResumeSchema,
  MigrateResumableSchema,
  CleanupUnfavoriteSchema,
  StatusQuerySchema,
} from '../src/schemas.js';

/**
 * T-1: engine zod schema 回归测试。
 * 防止 P0-1（StatusQuerySchema 字段名 source 应为 job）类问题重现——
 * schema 字段名必须与 handler 实际读取的字段、GUI 发送的字段一致。
 */
describe('engine schemas (N7, T-1)', () => {
  describe('字段名与 handler/GUI 一致', () => {
    it('StatusQuerySchema 用 job（非 source）— P0-1 回归', () => {
      // GUI 发 { job, stateDir }，handler 读 params.job
      const valid = StatusQuerySchema.safeParse({ job: 'mig-1', stateDir: '/tmp/x' });
      expect(valid.success).toBe(true);
      // source 字段不应被接受为唯一 id（P0-1 的 bug 是 schema 要求 source）
      const wrongField = StatusQuerySchema.safeParse({ source: 'mig-1', stateDir: '/tmp/x' });
      expect(wrongField.success).toBe(false);
    });

    it('CleanupUnfavoriteSchema 有 confirmed 字段（M6）', () => {
      const valid = CleanupUnfavoriteSchema.safeParse({
        source: 's1', stateDir: '/tmp/x', confirmed: true,
      });
      expect(valid.success).toBe(true);
    });
  });

  describe('valid params 通过', () => {
    it('AuthLoginSchema', () => {
      expect(AuthLoginSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(true);
    });
    it('AuthStatusSchema', () => {
      expect(AuthStatusSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(true);
    });
    it('ScanStartSchema', () => {
      expect(ScanStartSchema.safeParse({ source: 's1', stateDir: '/x', favoritesUrl: 'https://t.com/f' }).success).toBe(true);
    });
    it('MigrateStartSchema', () => {
      expect(MigrateStartSchema.safeParse({ source: 's1', target: 't1', stateDir: '/x', vaultPath: '/v' }).success).toBe(true);
    });
    it('MigrateResumeSchema', () => {
      expect(MigrateResumeSchema.safeParse({ job: 'mig-1', stateDir: '/x', vaultPath: '/v' }).success).toBe(true);
    });
    it('MigrateResumableSchema', () => {
      expect(MigrateResumableSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(true);
    });
  });

  describe('invalid params 被拒', () => {
    it('id 含非法字符被拒', () => {
      expect(AuthLoginSchema.safeParse({ source: 's 1', stateDir: '/x' }).success).toBe(false);
      expect(AuthLoginSchema.safeParse({ source: 's/1', stateDir: '/x' }).success).toBe(false);
    });
    it('空 stateDir 被拒', () => {
      expect(AuthLoginSchema.safeParse({ source: 's1', stateDir: '' }).success).toBe(false);
    });
    it('负数 intervalMs 被拒', () => {
      expect(MigrateStartSchema.safeParse({ source: 's1', target: 't1', stateDir: '/x', vaultPath: '/v', intervalMs: -100 }).success).toBe(false);
    });
    it('NaN maxItems 被拒', () => {
      const r = ScanStartSchema.safeParse({ source: 's1', stateDir: '/x', favoritesUrl: 'https://t.com/f', maxItems: NaN });
      expect(r.success).toBe(false);
    });
    it('缺 favoritesUrl 被拒（scan.start 必填）', () => {
      expect(ScanStartSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(false);
    });
    it('cleanup 缺 confirmed 被拒', () => {
      expect(CleanupUnfavoriteSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(false);
    });
  });
});
