/**
 * 确认短语格式（§14.6）。提示与校验共用同一构造，防止两处格式漂移后
 * 提示显示的短语被校验方拒绝，把破坏性清理流程死锁。
 */
function formatConfirmationPhrase(prefix: string, count: number): string {
  return `${prefix} ${count}`;
}

/** §14.6 验证确认短语。只有完全匹配才继续。 */
export function validateConfirmation(input: string, expectedCount: number, prefix: string): boolean {
  return input === formatConfirmationPhrase(prefix, expectedCount);
}

/** §14.6 构建确认提示文本。 */
export function buildConfirmationPrompt(count: number, prefix: string): string {
  return [`即将取消收藏：${count} 条`, '', '请输入以下内容继续：', formatConfirmationPhrase(prefix, count)].join('\n');
}
