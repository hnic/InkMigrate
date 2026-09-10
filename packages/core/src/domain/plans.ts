/**
 * §11.4 / §14.5 计划共有的完整性元数据。两条计划记录都做哈希审计/恢复，
 * 共享字段在此声明一次，避免两份手抄副本漂移后悄然破坏完整性校验。
 *
 * 派生规则（以 source-toutiao/plan-generator 的实现为准）：
 * `planHash` 覆盖计划内容与 `configHash`，不含 `createdAt`（时间戳不参与哈希）。
 */
export interface PlanIntegrityMeta {
  /** 创建计划时数据库已应用到的 schema 版本（§11.4 / §14.5）。 */
  databaseSnapshotVersion: number;
  planHash: string;
  configHash: string;
  /** ISO 8601 UTC 时间戳（如 `2026-09-10T04:36:00Z`）：审计排序与哈希重算依赖统一格式。 */
  createdAt: string;
}

/**
 * §11.4 Migration Plan。开始提取前生成，用于审计与恢复；
 * 普通目标写入不需要人工确认。
 */
export interface MigrationPlan extends PlanIntegrityMeta {
  jobId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  sourceAdapterKind: string;
  sourceAdapterVersion: string;
  targetAdapterKind: string;
  targetAdapterVersion: string;
  candidateCount: number;
  excludedReasons: ReadonlyArray<{ fingerprint: string; reasonCode: string }>;
}

/**
 * §14.5 Cleanup Plan 摘要（§11.4 规范描述；持久化形状以 storage 层的
 * `CleanupPlanRow` 为准——其 `id` 列即本类型的 `planId`，并额外携带 `status`）。
 * 完整 items 数组在 `reports/cleanup/<action>-plan-<plan-id>.{json,csv,md}` 中
 * （文件名前缀取自 `action`，如 unfavorite/delete，由 plan-generator 生成）；
 * 数据库中只持久化摘要与计划哈希。
 *
 * `planId` 必须为文件名安全字符（`[A-Za-z0-9-]`，由 plan-generator 以
 * `cleanup-<ts>-<uuid8>` 约定生成），否则审计文件路径无法解析。
 * `action` 是来源适配器声明的开放动词词表（见 domain/capabilities.ts 的
 * `cleanupActions`），核心不在此收窄枚举。
 */
export interface CleanupPlanSummary extends PlanIntegrityMeta {
  planId: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  candidateCount: number;
  excludedCount: number;
}
