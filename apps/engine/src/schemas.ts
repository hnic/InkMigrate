/**
 * N7: RPC params 的 zod schema（信任边界校验）。
 *
 * 从 protocol.ts 的 TS 接口派生运行时校验，替代各 handler 内散落的 requireXxx
 * 守卫。校验在 transport.handleRequest 的 dispatch 前统一执行，失败返回 -32602。
 *
 * 字段语义与 protocol.ts 接口 + rpc-handlers.ts 的 requireXxx 守卫保持一致：
 * - id 字段：^[A-Za-z0-9_-]+$ 且 ≤64 字符（与 requireId 同口径；id 会成为
 *   路径段/DB 键，超长值应在校验期拒绝而非 handler 深处炸 ENAMETOOLONG）
 * - 数值字段：正数（与 requirePositiveMs/requirePositiveIntIfDefined 同口径）
 * - favoritesUrl：非空且必须 http(s)（由携带登录态的浏览器导航，file:/javascript:
 *   等杂值应在信任边界拒绝；scan.start 必填，其余方法可选但同样非空）
 * - 一律 strictObject：未知字段返回 -32602 而非静默剥离（strip 模式曾放过
 *   字段名拼写错误，如 MigrateResumeSchema 漏 intervalMs 被无声吞掉）
 *
 * 多 schema 重复的字段统一引用下述共享约束（stateDirField 等）：同一字段的
 * 口径只声明一处，避免逐份拷贝漂移（MigrateResumeSchema 漏 intervalMs 的教训）。
 */
import { z } from 'zod';

const positiveMs = z.number().positive().finite();
const positiveInt = z.number().int().positive();

const idField = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const stateDirField = z.string().min(1);
const vaultPathField = z.string().min(1);
const configPathField = z.string().min(1).optional();
/** favoritesUrl：携带登录态的浏览器导航地址，仅接受 http(s) 且非空；scan.start 必填。 */
const favoritesUrlRequired = z
  .string()
  .min(1)
  .regex(/^https?:\/\//i, 'favoritesUrl 必须是 http(s) URL');
const favoritesUrlField = favoritesUrlRequired.optional();
const maxItemsField = positiveInt.optional();
const intervalMsField = positiveMs.optional();

export const AuthLoginSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
  favoritesUrl: favoritesUrlField,
  timeoutMs: positiveMs.optional(),
});

export const AuthStatusSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
});

export const ScanStartSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
  favoritesUrl: favoritesUrlRequired,
  maxItems: maxItemsField,
  headless: z.boolean().optional(),
});

export const MigrateStartSchema = z.strictObject({
  source: idField,
  target: idField,
  stateDir: stateDirField,
  vaultPath: vaultPathField,
  favoritesUrl: favoritesUrlField,
  maxItems: maxItemsField,
  intervalMs: intervalMsField,
  configPath: configPathField,
});

export const MigrateResumeSchema = z.strictObject({
  job: idField,
  stateDir: stateDirField,
  vaultPath: vaultPathField,
  favoritesUrl: favoritesUrlField,
  maxItems: maxItemsField,
  // M5: resume 路径同样接受限速设置——runMigrateJob 对 start/resume 统一校验并
  // 转发 intervalMs；schema 漏声明会让该字段在 dispatch 前被剥离（I25 封号风险）。
  // 注意：@inkmigrate/protocol 的 MigrateResumeParams 尚未声明 intervalMs，此处
  // 先行放开（已知单向分歧而非漂移）；共享类型补齐前，类型化调用方需 cast 才能发送。
  intervalMs: intervalMsField,
  configPath: configPathField,
});

export const ScanPreviewSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
  configPath: z.string().min(1),
});

export const MigrateResumableSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
});

export const CleanupUnfavoriteSchema = z.strictObject({
  source: idField,
  stateDir: stateDirField,
  maxItems: maxItemsField,
  intervalMs: intervalMsField,
  /**
   * M6: 危险操作确认令牌（R3-M6: z.literal(true) 替代 z.boolean()，拒绝 false）。
   * 刻意与 @inkmigrate/protocol 的 `confirmed?: boolean` 分歧：运行时必须显式传
   * confirmed:true（缺省即拒），共享接口的宽松类型不应反向放宽此校验。
   */
  confirmed: z.literal(true),
});

export const StatusQuerySchema = z.strictObject({
  job: idField,
  stateDir: stateDirField,
});
