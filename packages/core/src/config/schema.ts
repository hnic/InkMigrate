import { z } from 'zod';

/**
 * §10.2 / §10.3 配置 Schema。
 *
 * 阶段 1 只固定顶层结构与安全相关字段；适配器特有的扩展项通过 `config:
 * Record<string, unknown>` 留扩展点，由各适配器在自己的 Zod Schema 中校验。
 * 未知顶层字段默认报错（§10.3），适配器扩展点必须在 `sources[].config` /
 * `targets[].config` 内部声明。
 */
export const WorkspaceSchema = z.object({
  stateDir: z.string().min(1),
  reportsDir: z.string().optional(),
  diagnosticsDir: z.string().optional(),
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .optional(),
  minFreeDiskBytes: z.number().int().nonnegative().optional(),
});

export const SourceConfigSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

export const TargetConfigSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

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
  .default({});

export const PrivacySchema = z
  .object({
    telemetry: z.boolean().default(false),
    redactLogs: z.boolean().default(true),
    retainFailureScreenshots: z.boolean().default(true),
    saveSanitizedHtml: z.boolean().default(true),
  })
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
