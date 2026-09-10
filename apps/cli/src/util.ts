/**
 * CLI 共享工具。
 */

/**
 * 状态数据库文件名（位于 workspace stateDir 下）。
 * 所有命令统一从这里取值，避免文件名硬编码散落各处后漂移。
 */
export const DB_FILENAME = 'inkmigrate.sqlite';

/**
 * 默认配置文件名：所有 `--config` 选项默认值与 init 生成的文件名共用，
 * 避免散落各处后漂移（init 生成了别的命令不读的文件）。
 */
export const CONFIG_FILENAME = 'inkmigrate.yaml';

/** 迁移报告目录名（位于 workspace stateDir 下）。 */
export const REPORTS_DIR_NAME = 'reports';

/** 迁移报告文件名（report 命令读取、migrate/resume 完成后提示的路径共用）。 */
export const REPORT_FILENAME = 'summary.md';

/**
 * 未知异常归一为可读消息。catch 分支统一用它，避免
 * `e instanceof Error ? e.message : String(e)` 三元散落多处后各自漂移。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * R3: 把字符串选项解析为正整数，NaN/非正数时抛错（被 commander 外层 catch 捕获）。
 * M-4: 原用 process.exit(1) 会跳过调用方的 finally { db.close()/session.close() }，
 * 导致 auth.ts 中浏览器已启动后传错 --timeout 泄漏 Chromium。改为 throw 让 finally
 * 正常执行。
 */
export function parsePositiveInt(raw: string, field: string): number {
  // Number 而非 parseInt：parseInt('10abc')/parseInt('30s') 会静默截断成
  // 10/30（--timeout 2m 变 2ms），Number + isInteger 拒绝一切非干净整数字符串
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`无效的 ${field} 值："${raw}"，必须是正整数`);
  }
  return n;
}

/**
 * R3: 可选正整数解析——undefined（参数未提供）返回 undefined，其余值（含空串
 * `--max-items=`，常来自未设置的 shell 变量）走 parsePositiveInt 严格校验，
 * 防止显式传空被当作"未提供"而回落默认值（cleanup 会放大到 200 条的清理范围）。
 */
export function parseOptionalPositiveInt(
  raw: string | undefined,
  field: string,
): number | undefined {
  if (raw === undefined) return undefined;
  return parsePositiveInt(raw, field);
}
