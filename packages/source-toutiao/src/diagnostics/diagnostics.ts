import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from '@inkmigrate/core';

export interface DiagnosticsInput {
  diagnosticsDir: string;
  jobId: string;
  itemKey: string;
  stage: string;
  attemptedSelectors?: string[];
  pageUrl?: string;
  pageTitle?: string;
  loginState?: string;
  securityChallenge?: boolean;
  generatedDegradedNote?: boolean;
  html?: string;
  errorCode?: string;
  errorMessage?: string;
  screenshotBuffer?: Buffer;
}

const redactor = createRedactor();

/**
 * §19.5 保存诊断数据。
 * 目录：`.inkmigrate/diagnostics/<jobId>/<itemKey>/`
 */
export function saveDiagnostics(i: DiagnosticsInput): void {
  const dir = join(i.diagnosticsDir, i.jobId, i.itemKey);
  mkdirSync(dir, { recursive: true });

  const errorData: Record<string, unknown> = {
    stage: i.stage,
    timestamp: new Date().toISOString(),
  };
  if (i.attemptedSelectors !== undefined) errorData.attemptedSelectors = i.attemptedSelectors;
  if (i.pageUrl !== undefined) errorData.pageUrl = redactor(i.pageUrl);
  if (i.pageTitle !== undefined) errorData.pageTitle = i.pageTitle;
  if (i.loginState !== undefined) errorData.loginState = i.loginState;
  if (i.securityChallenge !== undefined) errorData.securityChallenge = i.securityChallenge;
  if (i.generatedDegradedNote !== undefined) errorData.generatedDegradedNote = i.generatedDegradedNote;
  if (i.errorCode !== undefined) errorData.errorCode = i.errorCode;
  if (i.errorMessage !== undefined) errorData.errorMessage = redactor(i.errorMessage);
  writeFileSync(join(dir, 'error.json'), JSON.stringify(errorData, null, 2) + '\n', 'utf8');

  if (i.html !== undefined) {
    // 先移除 script/style 标签，再脱敏（避免 cookie 正则吞掉 </script>）
    let sanitized = i.html;
    sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
    sanitized = sanitized.replace(/<style[\s\S]*?<\/style>/gi, '');
    sanitized = redactor(sanitized);
    writeFileSync(join(dir, 'sanitized.html'), sanitized, 'utf8');
  }

  if (i.screenshotBuffer !== undefined) {
    writeFileSync(join(dir, 'screenshot.png'), i.screenshotBuffer);
  }
}
