import { openDatabase } from '../../src/index.js';
import type { DB } from '../../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** §16 文件级 SQLite 测试库，落在系统临时目录。close() 同时清理临时目录。 */
export function makeTempDb(): { db: DB; dir: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'inkmigrate-test-'));
  let db: DB;
  try {
    db = openDatabase({ path: join(dir, 'test.sqlite') });
  } catch (err) {
    // openDatabase 失败时回滚已创建的目录，避免遗留孤儿临时目录
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    db,
    dir,
    close: () => {
      // finally 保证清理必然执行：db.close() 抛错（打开的迭代器/忙句柄，或
      // Windows 上 WAL sidecar 持锁）时若直接串联，临时目录会泄漏成孤儿
      try {
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * §16 内存库；不启用 WAL，CI 速度更快。
 * 注意：返回裸 DB，调用方负责 `db.close()`（openDatabase 的既定契约）。
 */
export function makeMemoryDb(): DB {
  return openDatabase({ path: ':memory:', wal: false });
}
