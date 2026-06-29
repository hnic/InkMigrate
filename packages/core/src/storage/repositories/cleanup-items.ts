import type { DB } from '../database.js';

export interface CleanupItemInput {
  jobId: string;
  sourceItemId: number;
  precheckStatus: string;
  preActionState?: string | null;
  actionStatus: string;
  postActionState?: string | null;
  attemptCount?: number;
  actionStartedAt?: string | null;
  actionFinishedAt?: string | null;
  verifiedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  diagnosticPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CleanupItemRow {
  id: number;
  jobId: string;
  sourceItemId: number;
  precheckStatus: string;
  preActionState?: string | null;
  actionStatus: string;
  postActionState?: string | null;
  attemptCount: number;
  actionStartedAt?: string | null;
  actionFinishedAt?: string | null;
  verifiedAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  diagnosticPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 已成功取消收藏的 action_status 取值（编排器与排除查询共享）。 */
export const ACTION_STATUS_UNFAVORITED = 'unfavorited_verified';

/**
 * §缺陷修复：表示"对取消收藏目标已是终态、无需再处理"的 action_status 取值。
 * 即条目在源侧本就未收藏（打开后判定 not_favorited），或内容已删除（content_unavailable）。
 * 重跑时这些条目必须排除，否则会被反复重新导航打开（纯浪费 + 加剧风控暴露）。
 */
export const ACTION_STATUS_ALREADY_UNFAVORITED = 'already_unfavorited';

/**
 * §16.10 cleanup_items 仓储。单条目清理明细，UNIQUE(job_id, source_item_id) 支持断点续跑。
 */
export class CleanupItems {
  constructor(private db: DB) {}

  /** INSERT or UPDATE（同 job+item 重复时更新，支持重试/续跑）。 */
  upsert(i: CleanupItemInput): void {
    this.db
      .prepare(
        `INSERT INTO cleanup_items(job_id, source_item_id, precheck_status, pre_action_state, action_status, post_action_state, attempt_count, action_started_at, action_finished_at, verified_at, last_error_code, last_error_message, diagnostic_path, created_at, updated_at)
         VALUES(@jobId, @sourceItemId, @precheckStatus, @preActionState, @actionStatus, @postActionState, @attemptCount, @actionStartedAt, @actionFinishedAt, @verifiedAt, @lastErrorCode, @lastErrorMessage, @diagnosticPath, @createdAt, @updatedAt)
         ON CONFLICT(job_id, source_item_id) DO UPDATE SET
           precheck_status=excluded.precheck_status,
           pre_action_state=excluded.pre_action_state,
           action_status=excluded.action_status,
           post_action_state=excluded.post_action_state,
           attempt_count=excluded.attempt_count,
           action_started_at=excluded.action_started_at,
           action_finished_at=excluded.action_finished_at,
           verified_at=excluded.verified_at,
           last_error_code=excluded.last_error_code,
           last_error_message=excluded.last_error_message,
           diagnostic_path=excluded.diagnostic_path,
           updated_at=excluded.updated_at`,
      )
      .run({
        preActionState: null, postActionState: null,
        attemptCount: 1,
        actionStartedAt: null, actionFinishedAt: null, verifiedAt: null,
        lastErrorCode: null, lastErrorMessage: null, diagnosticPath: null,
        ...i,
      });
  }

  listByJob(jobId: string): CleanupItemRow[] {
    return this.db
      .prepare(
        `SELECT id, job_id AS jobId, source_item_id AS sourceItemId,
                precheck_status AS precheckStatus, pre_action_state AS preActionState,
                action_status AS actionStatus, post_action_state AS postActionState,
                attempt_count AS attemptCount,
                action_started_at AS actionStartedAt, action_finished_at AS actionFinishedAt,
                verified_at AS verifiedAt,
                last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage,
                diagnostic_path AS diagnosticPath,
                created_at AS createdAt, updated_at AS updatedAt
         FROM cleanup_items WHERE job_id=? ORDER BY id`,
      )
      .all(jobId) as CleanupItemRow[];
  }

  /** 查询某 plan 体系下已无需再处理的 source_item_id（用于排除重跑）。
   *  跨 job：只要该 source_item 在任意清理中已落到"终态"action_status，就不再选中。
   *  终态包含：unfavorited_verified（真正取消成功）+ already_unfavorited（本就未收藏/
   *  内容删除——对取消收藏目标已是终态）。§缺陷修复：此前漏排 already_unfavorited，
   *  导致重跑反复重新打开这些页面。 */
  findUnfavoritedSourceItemIds(sourceInstanceId: string): Set<number> {
    const rows = this.db
      .prepare(
        `SELECT ci.source_item_id AS id
         FROM cleanup_items ci
         JOIN cleanup_jobs cj ON cj.id = ci.job_id
         JOIN cleanup_plans cp ON cp.id = cj.plan_id
         WHERE cp.source_instance_id = ?
           AND ci.action_status IN (?, ?)`,
      )
      .all(sourceInstanceId, ACTION_STATUS_UNFAVORITED, ACTION_STATUS_ALREADY_UNFAVORITED) as Array<{ id: number }>;
    return new Set(rows.map((r) => r.id));
  }
}
