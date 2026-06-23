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
  writeFileSync(
    join(jobDir, 'scan-report.json'),
    JSON.stringify(json, null, 2) + '\n',
    'utf8',
  );

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
  writeFileSync(join(jobDir, 'scan-report.md'), md, 'utf8');
}
