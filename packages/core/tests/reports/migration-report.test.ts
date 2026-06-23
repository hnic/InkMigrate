import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateMigrationReport } from '../../src/reports/migration-report.js';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinalStateCounts } from '../../src/domain/states.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'report-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const counts: FinalStateCounts = {
  verified: 80,
  degraded: 5,
  permanent_failed: 3,
  unsupported: 2,
  blocked: 1,
  conflict: 4,
  skipped: 5,
};

describe('generateMigrationReport (§21.2)', () => {
  it('generates summary.json with correct counts', () => {
    generateMigrationReport({
      reportsDir: dir,
      jobId: 'j1',
      scanCount: 100,
      candidateCount: 100,
      counts,
      items: [
        { fingerprint: 'fp1', title: 't1', status: 'verified', contentKind: 'article' },
        { fingerprint: 'fp2', title: 't2', status: 'degraded', contentKind: 'article' },
      ],
      reconciliationOk: true,
    });
    const summary = JSON.parse(
      readFileSync(join(dir, 'j1', 'summary.json'), 'utf8'),
    );
    expect(summary.scan_count).toBe(100);
    expect(summary.verified_count).toBe(80);
    expect(summary.failed_count).toBe(6);
    expect(summary.permanent_failed_count).toBe(3);
    expect(summary.unsupported_count).toBe(2);
    expect(summary.blocked_count).toBe(1);
  });

  it('generates summary.md (human-readable)', () => {
    generateMigrationReport({
      reportsDir: dir,
      jobId: 'j1',
      scanCount: 100,
      candidateCount: 100,
      counts,
      items: [],
      reconciliationOk: true,
    });
    const md = readFileSync(join(dir, 'j1', 'summary.md'), 'utf8');
    expect(md).toContain('verified');
    expect(md).toContain('80');
    expect(md).toContain('failed');
    expect(md).toContain('6');
  });

  it('generates items.csv, failed-items.csv, degraded-items.csv', () => {
    generateMigrationReport({
      reportsDir: dir,
      jobId: 'j1',
      scanCount: 3,
      candidateCount: 3,
      counts: {
        verified: 1, degraded: 1, permanent_failed: 1,
        unsupported: 0, blocked: 0, conflict: 0, skipped: 0,
      },
      items: [
        { fingerprint: 'fp1', title: 'ok', status: 'verified', contentKind: 'article' },
        { fingerprint: 'fp2', title: 'deg', status: 'degraded', contentKind: 'article' },
        { fingerprint: 'fp3', title: 'fail', status: 'permanent_failed', contentKind: 'article' },
      ],
      reconciliationOk: true,
    });
    expect(existsSync(join(dir, 'j1', 'items.csv'))).toBe(true);
    expect(existsSync(join(dir, 'j1', 'failed-items.csv'))).toBe(true);
    expect(existsSync(join(dir, 'j1', 'degraded-items.csv'))).toBe(true);
    const failed = readFileSync(join(dir, 'j1', 'failed-items.csv'), 'utf8');
    expect(failed).toContain('fail');
    expect(failed).not.toContain('ok');
    const degraded = readFileSync(join(dir, 'j1', 'degraded-items.csv'), 'utf8');
    expect(degraded).toContain('deg');
  });

  it('marks reconciliation failure in summary', () => {
    generateMigrationReport({
      reportsDir: dir,
      jobId: 'j1',
      scanCount: 100,
      candidateCount: 100,
      counts,
      items: [],
      reconciliationOk: false,
      reconciliationReason: 'integrity equation failed',
    });
    const summary = JSON.parse(
      readFileSync(join(dir, 'j1', 'summary.json'), 'utf8'),
    );
    expect(summary.reconciliation_ok).toBe(false);
    expect(summary.reconciliation_reason).toContain('equation');
  });
});
