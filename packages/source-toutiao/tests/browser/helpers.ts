import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 为每个浏览器测试创建独立的临时 Profile 目录。
 * launchPersistentContext 会锁定目录，所以每个测试必须用不同的目录。
 */
export function createTempProfileDir(): string {
  return mkdtempSync(join(tmpdir(), 'inkmigrate-browser-test-'));
}

/** 用于路由拦截的 1×1 透明 PNG。 */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
