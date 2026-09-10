/** §18.4 锁文件 JSON 内容。 */
export interface LockFileContent {
  pid: number;
  hostname: string;
  jobId: string;
  startedAt: string;
  /** 心跳时间。约定为 Date#toISOString() 产出的 ISO-8601（含时区偏移）；
   * Date.parse 对其他格式的解析是实现定义的，跨运行时结果不一致。 */
  heartbeatAt: string;
}

/** §18.4 视为陈旧锁的心跳间隔（毫秒）。超过该间隔未刷新视为持有方已失活。 */
export const STALE_MS = 60_000;

/**
 * 判断锁文件是否陈旧。
 *
 * - 心跳字段缺失/非字符串/无法解析时视为陈旧（fail-open：优先保证锁可被
 *   接管；存活持有方的安全由 fd 的 nlink 接管检测兜底，而非依赖本判定
 *   不误杀——调用方 JSON.parse 的结果未经形状校验，null/畸形载荷必须
 *   确定性地落入陈旧分支而非抛 TypeError）。
 * - 心跳显著超前于本地时钟（跨机时钟偏移、人工/损坏数据）时同样视为陈旧：
 *   此时 now - hb 为负、永远追不上 STALE_MS，锁将卡死到本地时钟追平为止，
 *   是 job-runner 已知「锁被卡住」失败模式的又一向量。
 */
export function isStaleLock(
  content: LockFileContent | null | undefined,
  now = Date.now(),
): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content.heartbeatAt !== 'string') return true;
  const hb = Date.parse(content.heartbeatAt);
  if (Number.isNaN(hb)) return true;
  // 心跳超前超过陈旧阈值即视为不可信（正常心跳每秒刷新，不可能合法超前 60s）
  if (hb - now > STALE_MS) return true;
  return now - hb > STALE_MS;
}
