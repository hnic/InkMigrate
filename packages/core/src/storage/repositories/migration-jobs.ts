import type { DB } from '../database.js';
import {
  JOB_STATUS,
  JOB_TRANSITIONS,
  isJobStatus,
  canJobTransition,
  type JobStatus,
} from '../../domain/states.js';

/** 合法 status 词表文案：从 domain 单一真相源派生，增删状态时错误信息自动同步。 */
const LEGAL_JOB_STATUS = JOB_STATUS.join('/');

/**
 * §11.1 跨状态转换 + 自环（同 status 内推进 current_stage）。
 * M9: 矩阵改为引用 domain/states.ts 的单一真相源，消除本地副本漂移。
 */
function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  // 自环（to === from）仅对非终态开放：running/paused 内推进 current_stage 不是
  // 状态转换，矩阵只约束跨状态转换。completed/failed 在 JOB_TRANSITIONS 中无出边，
  // 借「status 不变」改写终态 Job 的 current_stage/finished_at 同样必须拒绝
  //（否则违反「终态的 Job 无法再被改写」不变量）。
  if (to === from) return JOB_TRANSITIONS[from].size > 0;
  return canJobTransition(from, to);
}

export interface MigrationJobInput {
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  status: string;
  currentStage: string;
  planId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationJobRow {
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  planId?: string;
  status: string;
  currentStage: string;
  pauseReasonCode?: string;
  pausedAt?: string;
  scanCount: number;
  candidateCount: number;
  verifiedCount: number;
  degradedCount: number;
  failedCount: number;
  conflictCount: number;
  skippedCount: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCountsInput {
  scanCount?: number;
  candidateCount?: number;
  verifiedCount?: number;
  degradedCount?: number;
  failedCount?: number;
  conflictCount?: number;
  skippedCount?: number;
}

export interface UpdateStatusInput {
  status: string;
  currentStage?: string;
  pauseReasonCode?: string | null;
  pausedAt?: string | null;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

/**
 * §16.3 migration_jobs 仓储。
 *
 * 计数列是便于显示的缓存（§16.3 字段语义）；Job 完成前核心必须从条目终态
 * 重新派生明细并核对，缓存不是唯一事实来源。这里只提供写入与读取，对账逻辑
 * 由 application 层的 migration-service 负责。
 */
export class MigrationJobs {
  constructor(private db: DB) {}

  create(i: MigrationJobInput): void {
    // M1: 与 updateStatus 同源校验——create 也不能绕过状态机写入任意字符串
    //（schema 的 CHECK 仅在 v2+ 存在，且拼写错误在此拦截更早）。
    if (!isJobStatus(i.status)) {
      throw new Error(
        `非法 Job status 值："${i.status}"（id=${i.id}）；合法值：${LEGAL_JOB_STATUS}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO migration_jobs(id,source_instance_id,target_instance_id,plan_id,status,current_stage,scan_count,candidate_count,verified_count,degraded_count,failed_count,conflict_count,skipped_count,created_at,updated_at)
         VALUES(@id,@sourceInstanceId,@targetInstanceId,@planId,@status,@currentStage,0,0,0,0,0,0,0,@createdAt,@updatedAt)`,
      )
      // ?? 归一：显式传入的 undefined 不能覆盖 null 默认值（better-sqlite3 拒绝 undefined 绑定值）。
      .run({ ...i, planId: i.planId ?? null });
  }

  get(id: string): MigrationJobRow | undefined {
    return this.db
      .prepare(
        `SELECT id, source_instance_id AS sourceInstanceId, target_instance_id AS targetInstanceId,
                plan_id AS planId, status, current_stage AS currentStage,
                pause_reason_code AS pauseReasonCode, paused_at AS pausedAt,
                scan_count AS scanCount, candidate_count AS candidateCount,
                verified_count AS verifiedCount, degraded_count AS degradedCount,
                failed_count AS failedCount, conflict_count AS conflictCount,
                skipped_count AS skippedCount, started_at AS startedAt,
                finished_at AS finishedAt, created_at AS createdAt, updated_at AS updatedAt
         FROM migration_jobs WHERE id=?`,
      )
      .get(id) as MigrationJobRow | undefined;
  }

  /** §16.3 更新缓存计数列。未传入的字段不动。同时刷新 updated_at（与 CleanupJobs.updateCounts
   *  一致：计数列是便于显示的缓存非审计事实，updated_at 由仓储以当前时间刷新）。 */
  updateCounts(id: string, c: UpdateCountsInput): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      // 白名单映射：SET 片段由键名拼接进 SQL，不能依赖调用方类型约束兜底
      const col = COUNT_COLUMNS[k];
      if (col === undefined) {
        throw new Error(`updateCounts: 未知计数字段 "${k}"（id=${id}）`);
      }
      // 计数列须为非负安全整数：TS 可选类型不构成运行时约束，负数/小数/null
      // 一旦落库会污染缓存计数且无信号
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new Error(
          `updateCounts: 非法计数值 "${k}"=${JSON.stringify(v)}（id=${id}），须为非负整数`,
        );
      }
      sets.push(`${col} = @${k}`);
      params[k] = v;
    }
    if (sets.length === 0) return;
    const result = this.db
      .prepare(
        `UPDATE migration_jobs SET ${sets.join(', ')}, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({ ...params, updatedAt: new Date().toISOString() });
    // 行不存在时抛错而非静默 no-op（与 updateStatus 同约定）
    if (result.changes === 0) {
      throw new Error(`migration_jobs 不存在：id=${id}，updateCounts 未生效`);
    }
  }

  /**
   * §11.1 更新 Job 生命周期 status、current_stage 与暂停相关字段。
   *
   * 字段语义（M-修正：原注释声称四个时间/暂停字段均为显式 SET，与实现不符）：
   * - pauseReasonCode/pausedAt：以目标 status 为主干——目标为 paused 时传值即覆盖、
   *   省略保留原值（paused 自环推进 current_stage 不丢暂停审计）；目标非 paused
   *   （如恢复 running）则一律清空，即使调用方误传也不写入非暂停 Job（避免审计污染）。
   * - startedAt/finishedAt：COALESCE(列, 参数) 补写式——仅在列值为空时写入，
   *   已有值不被覆盖也不可清空（保留首次启动/完成时间的审计事实）。
   *
   * §11.1 状态转换守卫：读取当前 status，按 JOB_TRANSITIONS 校验目标 status 合法性。
   * 终态（completed/failed）的 Job 无法再被改写，断点续跑只能从 paused/interrupted 恢复。
   * 这把规格里的转换矩阵从"纸上规则"升级为运行期强制约束，防止并发/误操作写出非法状态。
   *
   * M1: 未知 status（拼写错误等）直接抛错，而非原实现那样静默跳过守卫直写 DB。
   * 读-校验-写包入事务，消除单连接内的 TOCTOU 窗口。
   */
  updateStatus(id: string, u: UpdateStatusInput): void {
    // M1: 未知 status 直接拒绝——原实现仅在 isJobStatus 为真时校验，非法状态会
    // 绕过守卫直写 DB（配合 schema 缺 CHECK，拼写错误被静默持久化）。
    if (!isJobStatus(u.status)) {
      throw new Error(
        `非法 Job status 值："${u.status}"（id=${id}）；合法值：${LEGAL_JOB_STATUS}`,
      );
    }
    // 守卫后固化为 JobStatus，供事务闭包内使用（闭包会丢失类型收窄）。
    const targetStatus: JobStatus = u.status;
    // 读-校验-写包入事务，消除 TOCTOU（M1）。
    const txn = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT status FROM migration_jobs WHERE id=?')
        .get(id) as { status: string } | undefined;
      // 行不存在时抛错而非静默 no-op：UPDATE 影响 0 行会让调用方误以为已落库。
      if (current === undefined) {
        throw new Error(`migration_jobs 不存在：id=${id}，updateStatus 未生效`);
      }
      // 存量 status 非法（脏数据/绕过校验写入）同样拒绝：跳过守卫直写等于放弃状态机保护。
      if (!isJobStatus(current.status)) {
        throw new Error(
          `DB 中存在非法 Job status 值："${current.status}"（id=${id}），拒绝更新以避免绕过状态机`,
        );
      }
      if (!canTransitionTo(current.status, targetStatus)) {
        throw new Error(
          `非法 Job 状态转换：${current.status} → ${targetStatus}（id=${id}）。` +
            `终态（completed/failed）不可再转换；resume 只能从 paused/interrupted 恢复。`,
        );
      }
      this.db
        .prepare(
          `UPDATE migration_jobs
           SET status=@status,
               current_stage=COALESCE(@currentStage, current_stage),
               pause_reason_code=CASE WHEN @status='paused' THEN COALESCE(@pauseReasonCode, pause_reason_code) END,
               paused_at=CASE WHEN @status='paused' THEN COALESCE(@pausedAt, paused_at) END,
               started_at=COALESCE(started_at, @startedAt),
               finished_at=COALESCE(finished_at, @finishedAt),
               updated_at=@updatedAt
           WHERE id=@id`,
        )
        .run({
          id,
          status: u.status,
          currentStage: u.currentStage ?? null,
          pauseReasonCode: u.pauseReasonCode ?? null,
          pausedAt: u.pausedAt ?? null,
          startedAt: u.startedAt ?? null,
          finishedAt: u.finishedAt ?? null,
          updatedAt: u.updatedAt,
        });
    });
    txn();
  }
}

/** updateCounts 可更新的计数列白名单（camelCase → snake_case），亦防未知键注入 SET 片段。 */
const COUNT_COLUMNS: Record<string, string> = {
  scanCount: 'scan_count',
  candidateCount: 'candidate_count',
  verifiedCount: 'verified_count',
  degradedCount: 'degraded_count',
  failedCount: 'failed_count',
  conflictCount: 'conflict_count',
  skippedCount: 'skipped_count',
};
