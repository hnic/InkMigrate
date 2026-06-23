import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'toutiao');

/** 读取 fixture HTML 文件内容。 */
export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, `${name}.html`), 'utf8');
}

export const FIXTURE_NAMES = [
  'article',
  'short-post',
  'gallery',
  'video',
  'deleted',
  'login-required',
  'challenge',
  'favorites-list',
] as const;
