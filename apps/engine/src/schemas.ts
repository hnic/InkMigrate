/**
 * N7: RPC params 的 zod schema（信任边界校验）。
 *
 * 从 protocol.ts 的 TS 接口派生运行时校验，替代各 handler 内散落的 requireXxx
 * 守卫。校验在 transport.handleRequest 的 dispatch 前统一执行，失败返回 -32602。
 *
 * 字段语义与 protocol.ts 接口 + rpc-handlers.ts 的 requireXxx 守卫保持一致：
 * - id 字段：^[A-Za-z0-9_-]+$（与 requireId 同口径）
 * - 数值字段：正数（与 requirePositiveMs/requirePositiveIntIfDefined 同口径）
 * - 一律 strictObject：未知字段返回 -32602 而非静默剥离（strip 模式曾放过
 *   字段名拼写错误，如 MigrateResumeSchema 漏 intervalMs 被无声吞掉）
 */
import { z } from 'zod';

const idField = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const positiveMs = z.number().positive().finite();
const positiveInt = z.number().int().positive();

export const AuthLoginSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
  favoritesUrl: z.string().optional(),
  timeoutMs: positiveMs.optional(),
});

export const AuthStatusSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
});

export const ScanStartSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
  favoritesUrl: z.string().min(1),
  maxItems: positiveInt.optional(),
  headless: z.boolean().optional(),
});

export const MigrateStartSchema = z.strictObject({
  source: idField,
  target: idField,
  stateDir: z.string().min(1),
  vaultPath: z.string().min(1),
  favoritesUrl: z.string().optional(),
  maxItems: positiveInt.optional(),
  intervalMs: positiveMs.optional(),
  configPath: z.string().min(1).optional(),
});

export const MigrateResumeSchema = z.strictObject({
  job: idField,
  stateDir: z.string().min(1),
  vaultPath: z.string().min(1),
  favoritesUrl: z.string().optional(),
  maxItems: positiveInt.optional(),
  // M5: resume 路径同样接受限速设置——runMigrateJob 对 start/resume 统一校验并
  // 转发 intervalMs；schema 漏声明会让该字段在 dispatch 前被剥离（I25 封号风险）。
  intervalMs: positiveMs.optional(),
  configPath: z.string().min(1).optional(),
});

export const ScanPreviewSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
  configPath: z.string().min(1),
});

export const MigrateResumableSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
});

export const CleanupUnfavoriteSchema = z.strictObject({
  source: idField,
  stateDir: z.string().min(1),
  maxItems: positiveInt.optional(),
  intervalMs: positiveMs.optional(),
  /**
   * M6: 危险操作确认令牌（R3-M6: z.literal(true) 替代 z.boolean()，拒绝 false）。
   * 刻意与 @inkmigrate/protocol 的 `confirmed?: boolean` 分歧：运行时必须显式传
   * confirmed:true（缺省即拒），共享接口的宽松类型不应反向放宽此校验。
   */
  confirmed: z.literal(true),
});

export const StatusQuerySchema = z.strictObject({
  job: idField,
  stateDir: z.string().min(1),
});
