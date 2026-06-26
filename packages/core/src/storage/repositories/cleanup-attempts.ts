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
    this.db
      .prepare(
        `INSERT INTO cleanup_action_attempts(cleanup_item_id, attempt_no, pre_action_state, action_result, post_action_state, started_at, finished_at, error_code, error_message, diagnostic_path, created_at)
         VALUES(@cleanupItemId, @attemptNo, @preActionState, @actionResult, @postActionState, @startedAt, @finishedAt, @errorCode, @errorMessage, @diagnosticPath, @createdAt)`,
      )
      .run({
        preActionState: null, actionResult: null, postActionState: null,
        finishedAt: null, errorCode: null, errorMessage: null, diagnosticPath: null,
        ...i,
      });
  }
}
