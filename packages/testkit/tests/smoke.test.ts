import { describe, it, expect } from 'vitest';
import {
  runSourceAdapterContract,
  runTargetAdapterContract,
} from '../src/index.js';
import type { SourceAdapter, TargetAdapter } from '@inkmigrate/core';

// Smoke test: confirm the testkit wires up correctly with a fake adapter
// satisfying §8.2/§8.4 contracts. Real adapter packages will do this in their
// own test files.

const fakeSource: SourceAdapter = {
  kind: 'fake',
  version: '1.0.0',
  adapterApiVersion: '1.0.0',
  capabilities: {
    authMode: 'none',
    discoveryMode: 'remote-list',
    supportsIncrementalScan: false,
    supportsAssets: false,
    supportsInternalLinks: false,
    supportsSourceCleanup: false,
    cleanupActions: [],
    supportedInputFormats: [],
  },
  validateConfig: async () => ({ ok: true }),
  prepare: async () => {},
  scan: async function* () {},
  extract: async () => {
    throw new Error('noop');
  },
  close: async () => {},
};

const fakeTarget: TargetAdapter = {
  kind: 'fake',
  version: '1.0.0',
  adapterApiVersion: '1.0.0',
  validateConfig: async () => ({ ok: true }),
  plan: async () => {
    throw new Error('noop');
  },
  write: async () => {
    throw new Error('noop');
  },
  verify: async () => {
    throw new Error('noop');
  },
};

describe('testkit smoke', () => {
  // Run contract suites inside this test file. The contract suite uses
  // describe/it internally; vitest supports nested describe.
  runSourceAdapterContract(() => fakeSource);
  runTargetAdapterContract(() => fakeTarget);

  it('exports runSourceAdapterContract and runTargetAdapterContract', () => {
    expect(typeof runSourceAdapterContract).toBe('function');
    expect(typeof runTargetAdapterContract).toBe('function');
  });
});
