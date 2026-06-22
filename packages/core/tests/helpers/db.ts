import { openDatabase } from '../../src/index.js';
import type { DB } from '../../src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** §16 文件级 SQLite 测试库，落在系统临时目录。 */
export function makeTempDb(): { db: DB; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-test-'));
  const db = openDatabase({ path: join(dir, 'test.sqlite') });
  return { db, dir, close: () => db.close() };
}

/** §16 内存库；不启用 WAL，CI 速度更快。 */
export function makeMemoryDb(): DB {
  return openDatabase({ path: ':memory:', wal: false });
}
