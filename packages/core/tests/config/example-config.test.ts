import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFromString } from '../../src/config/loader.js';

describe('example config fixture (§10.3 末)', () => {
  it('inkmigrate.example.yaml at repo root passes the schema', () => {
    // packages/core/tests/config/ → monorepo root is ../../../../
    const repoRoot = join(__dirname, '..', '..', '..', '..');
    const raw = readFileSync(join(repoRoot, 'inkmigrate.example.yaml'), 'utf8');
    expect(() => loadConfigFromString(raw)).not.toThrow();
  });
});
