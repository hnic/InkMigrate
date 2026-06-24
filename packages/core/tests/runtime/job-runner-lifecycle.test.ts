import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrationJob } from '../../src/runtime/job-runner.js';
import { openDatabase, type DB, type SourceAdapter, type TargetContext } from '../../src/index.js';
import { SourceInstances } from '../../src/storage/repositories/source-instances.js';
import { TargetInstances } from '../../src/storage/repositories/target-instances.js';
import { MigrationJobs } from '../../src/storage/repositories/migration-jobs.js';
import { createObsidianTarget } from '@inkmigrate/target-obsidian';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runMigrationJob lifecycle (§8.2 prepare/close)', () => {
  let dbDir: string;
  let vaultDir: string;
  let db: DB;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'job-runner-lifecycle-db-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'job-runner-lifecycle-vault-'));
    db = openDatabase({ path: join(dbDir, 'test.sqlite') });
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('calls prepare before scan and close in finally', async () => {
    new SourceInstances(db).create({
      id: 's1', adapterKind: 'test', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new TargetInstances(db).create({
      id: 't1', adapterKind: 'obsidian', adapterVersion: '1.0.0',
      adapterApiVersion: '1.0.0', configHash: 'h', createdAt: 't', updatedAt: 't',
    });
    new MigrationJobs(db).create({
      id: 'job1', sourceInstanceId: 's1', targetInstanceId: 't1',
      status: 'created', currentStage: 'preflight', createdAt: 't', updatedAt: 't',
    });

    const events: string[] = [];
    const mockSource: SourceAdapter = {
      kind: 'test',
      version: '1.0.0',
      adapterApiVersion: '1.0.0',
      capabilities: {
        authMode: 'browser-profile',
        discoveryMode: 'remote-list',
        supportsIncrementalScan: false,
        supportsAssets: false,
        supportsInternalLinks: false,
        supportsSourceCleanup: false,
        cleanupActions: [],
        supportedInputFormats: [],
      },
      validateConfig: async () => ({ ok: true }),
      prepare: async () => { events.push('prepare'); },
      scan: async function* () { events.push('scan'); },
      extract: async () => { throw new Error('not reached'); },
      close: async () => { events.push('close'); },
    };

    const targetContext: TargetContext = {
      config: {},
      workspaceDir: dbDir,
      vaultPath: vaultDir,
      targetConfig: {
        vaultPath: vaultDir,
        importSubdir: 'Imports',
        attachmentsSubdir: 'Attachments',
        linkStyle: 'wikilink',
        overwritePolicy: 'preserve',
        collectionMapping: { toTags: false, toFolders: false },
        maxFilenameLength: 100,
      },
    };

    await runMigrationJob({
      db,
      jobId: 'job1',
      sourceAdapter: mockSource,
      targetAdapter: createObsidianTarget(),
      sourceInstanceId: 's1',
      targetInstanceId: 't1',
      targetContext,
      workspaceDir: dbDir,
      reportsDir: join(dbDir, 'reports'),
    });

    expect(events).toEqual(['prepare', 'scan', 'close']);
  });
});
