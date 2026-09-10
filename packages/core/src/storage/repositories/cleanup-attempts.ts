import type { DB } from '../database.js';

export interface CleanupAttemptInput {
  cleanupItemId: number;
  attemptNo: number;
  preActionState?: string | null;
  actionResult?: string | null;
  postActionState?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  diagnosticPath?: string | null;
  createdAt: string;
}

/**
 * §16.11 cleanup_action_attempts 仓储。单次尝试审计日志，
 * UNIQUE(cleanup_item_id, attempt_no) 保证幂等。
 */
export class CleanupAttempts {
  constructor(private db: DB) {}

  create(i: CleanupAttemptInput): void {
    // C4: 用 ON CONFLICT DO NOTHING 兑现「UNIQUE 保证幂等」的契约。原普通 INSERT
    // 在崩溃恢复重跑同一 (cleanup_item_id, attempt_no) 时会抛 SQLITE_CONSTRAINT_UNIQUE，
    // 而非 no-op——与 cleanup-items.upsert（用了 ON CONFLICT）风格不一致，且异常
    // 未被调用方捕获处理。
    this.db
      .prepare(
        `INSERT INTO cleanup_action_attempts(cleanup_item_id, attempt_no, pre_action_state, action_result, post_action_state, started_at, finished_at, error_code, error_message, diagnostic_path, created_at)
         VALUES(@cleanupItemId, @attemptNo, @preActionState, @actionResult, @postActionState, @startedAt, @finishedAt, @errorCode, @errorMessage, @diagnosticPath, @createdAt)
         ON CONFLICT(cleanup_item_id, attempt_no) DO NOTHING`,
      )
      .run({
        ...i,
        // 逐字段 ?? 归一：显式传入的 undefined（可选属性合法）不能覆盖 null 默认值，
        // 否则 better-sqlite3 拒绝 undefined 绑定值而在运行期抛错。
        preActionState: i.preActionState ?? null,
        actionResult: i.actionResult ?? null,
        postActionState: i.postActionState ?? null,
        finishedAt: i.finishedAt ?? null,
        errorCode: i.errorCode ?? null,
        errorMessage: i.errorMessage ?? null,
        diagnosticPath: i.diagnosticPath ?? null,
      });
  }
}
