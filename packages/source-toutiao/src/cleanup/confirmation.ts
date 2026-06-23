/** §14.6 验证确认短语。只有完全匹配才继续。 */
export function validateConfirmation(input: string, expectedCount: number, prefix: string): boolean {
  return input === `${prefix} ${expectedCount}`;
}

/** §14.6 构建确认提示文本。 */
export function buildConfirmationPrompt(count: number, prefix: string): string {
  return [`即将取消收藏：${count} 条`, '', '请输入以下内容继续：', `${prefix} ${count}`].join('\n');
}
