/**
 * §11.4 Migration Plan。开始提取前生成，用于审计与恢复；
 * 普通目标写入不需要人工确认。
 */
export interface MigrationPlan {
  jobId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  sourceAdapterKind: string;
  sourceAdapterVersion: string;
  targetAdapterKind: string;
  targetAdapterVersion: string;
  candidateCount: number;
  excludedReasons: ReadonlyArray<{ fingerprint: string; reasonCode: string }>;
  configHash: string;
  databaseSnapshotVersion: number;
  planHash: string;
  createdAt: string;
}

/**
 * §14.5 Cleanup Plan 摘要。完整 items 数组在 `reports/cleanup/unfavorite-plan-<plan-id>.json`
 * 中；数据库中只持久化摘要与计划哈希。
 */
export interface CleanupPlanSummary {
  planId: string;
  sourceInstanceId: string;
  migrationJobId: string;
  action: string;
  candidateCount: number;
  excludedCount: number;
  databaseSnapshotVersion: number;
  planHash: string;
  configHash: string;
  createdAt: string;
}
