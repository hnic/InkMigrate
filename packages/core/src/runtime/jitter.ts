/**
 * §18.1 防风控抖动（jitter）工具。
 *
 * 固定间隔是人类行为的反指纹——请求时间间隔方差接近 0 时极易被风控模型
 * 识别为自动化。本模块在基准值周围做均匀抖动采样，让间隔分布接近真实人类。
 *
 * 抖动幅度固定在代码里（不暴露给 GUI/CLI）：基准 intervalMs 仍是用户可调的入口，
 * 抖动比例取经验值，避免增加配置面。
 */

/** 条目间间隔默认抖动比例 ±40%（采样落在 [0.6×, 1.4×] 基准区间）。 */
export const ITEM_INTERVAL_JITTER = 0.4;
/** 重试退避默认抖动比例 ±50%（采样落在 [0.5×, 1.5×] 基准区间）。 */
export const RETRY_BACKOFF_JITTER = 0.5;

/**
 * 在基准值 `base` 周围按 `jitterRatio` 做均匀抖动采样。
 *
 * 返回值 ∈ [base×(1-ratio), base×(1+ratio)]（四舍五入为整数毫秒，下限 0）。
 *
 * @param base 基准毫秒数（≥ 0）。
 * @param jitterRatio 抖动比例，范围 [0, 1]；0 表示不抖动（恒等于 base）。
 * @param random 可注入的随机源，默认 Math.random，便于测试做确定性断言。
 *
 * 输入契约在此强制而非信任调用方：base/jitterRatio 可能源自用户配置，非有限值
 * 传给 setTimeout 会被静默截断为 0ms，恰好产生本模块要消除的固定零间隔，故入口
 * 显式失败；越界值收敛到文档范围。
 */
export function withJitter(
  base: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  if (!Number.isFinite(base) || !Number.isFinite(jitterRatio)) {
    throw new RangeError(
      `withJitter: base 与 jitterRatio 必须为有限数值（base=${base}, jitterRatio=${jitterRatio}）`,
    );
  }
  const safeBase = Math.max(0, base);
  const safeRatio = Math.min(1, Math.max(0, jitterRatio));
  const factor = 1 + (random() * 2 - 1) * safeRatio;
  return Math.max(0, Math.round(safeBase * factor));
}
