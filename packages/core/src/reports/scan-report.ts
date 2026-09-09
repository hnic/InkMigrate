import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScanReportInput {
  reportsDir: string;
  jobId: string;
  uniqueItems: number;
  duplicateObservations: number;
  scrollIterations: number;
  terminationReason: string;
  completenessConfidence: string;
  adapterKind: string;
  adapterVersion: string;
}

/** §21.1 生成扫描报告。 */
export function generateScanReport(i: ScanReportInput): void {
  // jobId 会拼接进文件系统路径，拒绝含路径字符的输入（防穿越写报告）
  if (!/^[A-Za-z0-9_-]+$/.test(i.jobId)) {
    throw new Error(
      `invalid jobId (path characters rejected): ${JSON.stringify(i.jobId)}`,
    );
  }
  const jobDir = join(i.reportsDir, i.jobId);
  mkdirSync(jobDir, { recursive: true });

  const json = {
    job_id: i.jobId,
    unique_items: i.uniqueItems,
    duplicate_observations: i.duplicateObservations,
    scroll_iterations: i.scrollIterations,
    termination_reason: i.terminationReason,
    completeness_confidence: i.completenessConfidence,
    adapter_kind: i.adapterKind,
    adapter_version: i.adapterVersion,
  };

  const md = [
    `# 扫描报告 ${i.jobId}`,
    '',
    `- 唯一条目数：${i.uniqueItems}`,
    `- 重复观察数：${i.duplicateObservations}`,
    `- 滚动迭代：${i.scrollIterations}`,
    `- 终止原因：${i.terminationReason}`,
    `- 完整性置信度：${i.completenessConfidence}`,
    `- 适配器：${i.adapterKind}@${i.adapterVersion}`,
    '',
  ].join('\n');

  // 写入失败时带上 job 与目录上下文重新抛出，便于定位；replacer 把 undefined
  // 归一为 null，保证宽松调用下 JSON 报告的字段集稳定。
  try {
    writeFileSync(
      join(jobDir, 'scan-report.json'),
      JSON.stringify(json, (_k, v) => (v === undefined ? null : v), 2) + '\n',
      'utf8',
    );
    writeFileSync(join(jobDir, 'scan-report.md'), md, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to write scan report for job ${i.jobId} under ${jobDir}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
