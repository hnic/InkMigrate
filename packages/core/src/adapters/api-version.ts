import semver from 'semver';

/**
 * §8.6 核心声明的适配器 API 兼容范围。当前契约版本为 1.x；主版本号变更视为
 * 不兼容。次版本与修订版本在核心声明的兼容范围内允许。
 */
export const SUPPORTED_ADAPTER_API_RANGE = '>=1.0.0 <2.0.0';

/**
 * §8.6 适配器 API 版本兼容性检查。启动时先校验 API 范围，再执行配置验证；
 * 不兼容时以退出码 `16` 拒绝运行（退出码由 CLI 层处理，这里只决定兼容性）。
 *
 * 不接受 prerelease（避免 `1.0.0-beta` 被当作稳定契约）。
 */
export function isAdapterApiCompatible(adapterApiVersion: string): boolean {
  if (!semver.valid(adapterApiVersion)) {
    // 格式非法（如 'v1.0.0'、'1.2'）与"真实不兼容"分开报告：
    // semver.satisfies 对解析失败静默返回 false，会把声明笔误误诊为版本不兼容。
    throw new Error(
      `invalid adapter api version ${JSON.stringify(String(adapterApiVersion))}: expected strict semver (e.g. "1.4.0")`,
    );
  }
  return semver.satisfies(adapterApiVersion, SUPPORTED_ADAPTER_API_RANGE, {
    includePrerelease: false,
  });
}
