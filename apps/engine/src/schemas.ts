/**
 * N7: RPC params 的 zod schema（信任边界校验）。
 *
 * 从 protocol.ts 的 TS 接口派生运行时校验，替代各 handler 内散落的 requireXxx
 * 守卫。校验在 transport.handleRequest 的 dispatch 前统一执行，失败返回 -32602。
 *
 * 字段语义与 protocol.ts 接口 + rpc-handlers.ts 的 requireXxx 守卫保持一致：
 * - id 字段：^[A-Za-z0-9_-]+$（与 requireId 同口径）
 * - 数值字段：正数（与 requirePositiveMs/requirePositiveIntIfDefined 同口径）
 */
import { z } from 'zod';

const idField = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const positiveMs = z.number().positive().finite();
const positiveInt = z.number().int().positive();

export const AuthLoginSchema = z.object({
  source: idField,
  stateDir: z.string().min(1),
  favoritesUrl: z.string().optional(),
  timeoutMs: positiveMs.optional(),
});

export const AuthStatusSchema = z.object({
  source: idField,
  stateDir: z.string().min(1),
});

export const ScanStartSchema = z.object({
  source: idField,
  stateDir: z.string().min(1),
  favoritesUrl: z.string().min(1),
  maxItems: positiveInt.optional(),
  headless: z.boolean().optional(),
});

export const MigrateStartSchema = z.object({
  source: idField,
  target: idField,
  stateDir: z.string().min(1),
  vaultPath: z.string().min(1),
  favoritesUrl: z.string().optional(),
  maxItems: positiveInt.optional(),
  intervalMs: positiveMs.optional(),
});

export const MigrateResumeSchema = z.object({
  job: idField,
  stateDir: z.string().min(1),
  vaultPath: z.string().min(1),
  favoritesUrl: z.string().optional(),
  maxItems: positiveInt.optional(),
});

export const MigrateResumableSchema = z.object({
  source: idField,
  stateDir: z.string().min(1),
});

export const CleanupUnfavoriteSchema = z.object({
  source: idField,
  stateDir: z.string().min(1),
  maxItems: positiveInt.optional(),
  intervalMs: positiveMs.optional(),
  /** M6: 危险操作确认令牌（R3-M6: z.literal(true) 替代 z.boolean()，拒绝 false） */
  confirmed: z.literal(true),
});

export const StatusQuerySchema = z.object({
  job: idField,
  stateDir: z.string().min(1),
});
