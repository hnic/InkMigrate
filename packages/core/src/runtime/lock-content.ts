/** §18.4 锁文件 JSON 内容。 */
export interface LockFileContent {
  pid: number;
  hostname: string;
  jobId: string;
  startedAt: string;
  heartbeatAt: string;
}

/** §18.4 视为陈旧锁的心跳间隔（毫秒）。超过该间隔未刷新视为持有方已失活。 */
const STALE_MS = 60_000;

/**
 * 判断锁文件是否陈旧。心跳字段无法解析时也视为陈旧（保守策略）。
 */
export function isStaleLock(content: LockFileContent, now = Date.now()): boolean {
  const hb = Date.parse(content.heartbeatAt);
  if (Number.isNaN(hb)) return true;
  return now - hb > STALE_MS;
}
