import { z } from 'zod';

/**
 * §10.2 / §10.3 配置 Schema。
 *
 * 阶段 1 只固定顶层结构与安全相关字段；适配器特有的扩展项通过 `config:
 * Record<string, unknown>` 留扩展点，由各适配器在自己的 Zod Schema 中校验。
 * 未知字段（顶层与各嵌套节均含）默认报错（§10.3），避免拼写错误（如 `loglevel`）
 * 被静默剥离导致安全相关配置（磁盘水位等）悄然失效；适配器扩展点必须在
 * `sources[].config` / `targets[].config` 内部声明。
 */
export const WorkspaceSchema = z
  .object({
    stateDir: z.string().min(1),
    reportsDir: z.string().optional(),
    diagnosticsDir: z.string().optional(),
    logLevel: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .optional(),
    minFreeDiskBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

// source/target 端点条目结构完全同构，收敛为同一 schema，字段演进只改一处
const AdapterEndpointSchema = z
  .object({
    id: z.string().min(1),
    adapter: z.string().min(1),
    enabled: z.boolean().default(true),
    config: z.record(z.unknown()).default({}),
  })
  .strict();

export const SourceConfigSchema = AdapterEndpointSchema;
export const TargetConfigSchema = AdapterEndpointSchema;

/**
 * §10.2 / §14.2 sourceCleanup。阶段 1 仅固定 `enabled` 默认 `false` 与基本结构；
 * 完整安全字段（requireCleanupPlan / requireTypedConfirmation 等）在阶段 6
 * 源端清理实施时补全。
 */
export const SourceCleanupSchema = z
  .object({
    enabled: z.boolean().default(false),
    sourceId: z.string().optional(),
    action: z.string().optional(),
    executionMode: z.string().optional(),
  })
  .strict()
  .default({});

export const PrivacySchema = z
  .object({
    telemetry: z.boolean().default(false),
    redactLogs: z.boolean().default(true),
    retainFailureScreenshots: z.boolean().default(true),
    saveSanitizedHtml: z.boolean().default(true),
  })
  .strict()
  .default({});

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    workspace: WorkspaceSchema,
    sources: z.array(SourceConfigSchema).default([]),
    targets: z.array(TargetConfigSchema).default([]),
    sourceCleanup: SourceCleanupSchema,
    privacy: PrivacySchema,
  })
  .strict();

export type InkMigrateConfig = z.infer<typeof ConfigSchema>;
