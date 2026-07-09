/**
 * §14.8/§14.12 清理操作前的收藏状态枚举。
 *
 * 注意：此前的 decideCleanupAction 状态机决策函数（execute/skip/pause 映射）是死代码——
 * cleanup-orchestrator 走的是完全不同的内联路径（driveUnfavorite receipt → 四类映射），
 * 该函数与其逻辑已脱节，制造了"存在独立状态机决策层"的能力假象。已删除以消除歧义。
 * 仅保留 PreActionState 类型（orchestrator 用于 cleanup_items.precheck_status 字段）。
 */
export type PreActionState =
  | 'favorited' | 'not_favorited' | 'unknown'
  | 'login_required' | 'challenge_required' | 'content_unavailable';
