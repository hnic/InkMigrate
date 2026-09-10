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
    it('R3-M6: confirmed:false 被 schema 拒绝（z.literal(true) 替代 z.boolean()）', () => {
      const rejected = CleanupUnfavoriteSchema.safeParse({
        source: 's1', stateDir: '/tmp/x', confirmed: false,
      });
      expect(rejected.success).toBe(false);
    });
  });

  describe('R3-T5: schema 字段名与 handler/protocol 一致性（P0-1 类防护）', () => {
    // P0-1 是 StatusQuerySchema 用 source 而 handler 用 job 的字段名不匹配。
    // 此测试固化各 schema 的关键字段名，防止再次漂移。
    it('StatusQuerySchema 的 id 字段是 job', () => {
      const shape = StatusQuerySchema.shape as Record<string, unknown>;
      expect(shape).toHaveProperty('job');
      expect(shape).not.toHaveProperty('source');
    });
    it('MigrateResumeSchema 的 id 字段是 job', () => {
      const shape = MigrateResumeSchema.shape as Record<string, unknown>;
      expect(shape).toHaveProperty('job');
    });
    it('MigrateStartSchema 有 source 和 target', () => {
      const shape = MigrateStartSchema.shape as Record<string, unknown>;
      expect(shape).toHaveProperty('source');
      expect(shape).toHaveProperty('target');
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
    it('空 favoritesUrl 被拒（可选字段同样要求非空，与 scan.start 同口径）', () => {
      expect(MigrateStartSchema.safeParse({ source: 's1', target: 't1', stateDir: '/x', vaultPath: '/v', favoritesUrl: '' }).success).toBe(false);
      expect(MigrateResumeSchema.safeParse({ job: 'j1', stateDir: '/x', vaultPath: '/v', favoritesUrl: '' }).success).toBe(false);
      expect(AuthLoginSchema.safeParse({ source: 's1', stateDir: '/x', favoritesUrl: '' }).success).toBe(false);
    });
    it('非 http(s) 的 favoritesUrl 被拒（浏览器导航仅接受 http(s)）', () => {
      expect(ScanStartSchema.safeParse({ source: 's1', stateDir: '/x', favoritesUrl: 'file:///etc/passwd' }).success).toBe(false);
      expect(MigrateStartSchema.safeParse({ source: 's1', target: 't1', stateDir: '/x', vaultPath: '/v', favoritesUrl: 'javascript:alert(1)' }).success).toBe(false);
    });
    it('超长 id 被拒（≤64 字符，id 是路径段/DB 键）', () => {
      expect(AuthLoginSchema.safeParse({ source: 'a'.repeat(65), stateDir: '/x' }).success).toBe(false);
      expect(AuthLoginSchema.safeParse({ source: 'a'.repeat(64), stateDir: '/x' }).success).toBe(true);
    });
    it('cleanup 缺 confirmed 被拒', () => {
      expect(CleanupUnfavoriteSchema.safeParse({ source: 's1', stateDir: '/x' }).success).toBe(false);
    });
  });
});
