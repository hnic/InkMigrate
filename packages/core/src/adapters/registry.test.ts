import { describe, it, expect } from 'vitest';
import {
  AdapterRegistry,
  IncompatibleAdapterApiError,
  isAdapterApiCompatible,
  SUPPORTED_ADAPTER_API_RANGE,
} from './index.js';
import type { SourceAdapter, TargetAdapter } from './adapter.js';

function fakeSource(version: string, api: string, kind = 'fake'): SourceAdapter {
  return {
    kind,
    version,
    adapterApiVersion: api,
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
}

function fakeTarget(version: string, api: string, kind = 'fake'): TargetAdapter {
  return {
    kind,
    version,
    adapterApiVersion: api,
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
}

describe('api-version (§8.6)', () => {
  it('exposes the supported range as a SemVer range string', () => {
    expect(typeof SUPPORTED_ADAPTER_API_RANGE).toBe('string');
    expect(SUPPORTED_ADAPTER_API_RANGE).toMatch(/[<>]=?\d/);
  });
  it('accepts 1.0.0', () => {
    expect(isAdapterApiCompatible('1.0.0')).toBe(true);
  });
  it('accepts 1.x.x within range', () => {
    expect(isAdapterApiCompatible('1.5.2')).toBe(true);
  });
  it('rejects 2.0.0 (major bump)', () => {
    expect(isAdapterApiCompatible('2.0.0')).toBe(false);
  });
  it('rejects 0.9.0 (below range)', () => {
    expect(isAdapterApiCompatible('0.9.0')).toBe(false);
  });
  it('rejects prereleases outside compatibility window', () => {
    // 1.0.0-beta is prerelease; with includePrerelease:false it does not satisfy
    expect(isAdapterApiCompatible('1.0.0-beta')).toBe(false);
  });
});

describe('adapter registry (§8.2-§8.6)', () => {
  it('registers and resolves compatible source and target', () => {
    const reg = new AdapterRegistry();
    reg.registerSource(fakeSource('1.0.0', '1.0.0'));
    reg.registerTarget(fakeTarget('1.0.0', '1.0.0'));
    expect(reg.getSource('fake').kind).toBe('fake');
    expect(reg.getTarget('fake').kind).toBe('fake');
  });

  it('lists registered source and target kinds', () => {
    const reg = new AdapterRegistry();
    reg.registerSource(fakeSource('1.0.0', '1.0.0', 'src-a'));
    reg.registerSource(fakeSource('1.0.0', '1.0.0', 'src-b'));
    reg.registerTarget(fakeTarget('1.0.0', '1.0.0', 'tgt-a'));
    expect([...reg.listSources()].sort()).toEqual(['src-a', 'src-b']);
    expect(reg.listTargets()).toEqual(['tgt-a']);
  });

  it('rejects source adapter with incompatible api version (major mismatch)', () => {
    const reg = new AdapterRegistry();
    let thrown: unknown;
    try {
      reg.registerSource(fakeSource('1.0.0', '2.0.0'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IncompatibleAdapterApiError);
    expect((thrown as IncompatibleAdapterApiError).adapterKind).toBe('fake');
    expect((thrown as IncompatibleAdapterApiError).adapterApiVersion).toBe('2.0.0');
  });

  it('rejects target adapter with incompatible api version', () => {
    const reg = new AdapterRegistry();
    expect(() => reg.registerTarget(fakeTarget('1.0.0', '0.9.0'))).toThrow(
      IncompatibleAdapterApiError,
    );
  });

  it('rejects duplicate source kind', () => {
    const reg = new AdapterRegistry();
    reg.registerSource(fakeSource('1.0.0', '1.0.0'));
    expect(() => reg.registerSource(fakeSource('1.1.0', '1.0.0'))).toThrow(
      /already registered/,
    );
  });

  it('rejects duplicate target kind', () => {
    const reg = new AdapterRegistry();
    reg.registerTarget(fakeTarget('1.0.0', '1.0.0'));
    expect(() => reg.registerTarget(fakeTarget('1.1.0', '1.0.0'))).toThrow(
      /already registered/,
    );
  });

  it('throws on unknown source kind resolution', () => {
    const reg = new AdapterRegistry();
    expect(() => reg.getSource('missing')).toThrow(/not registered/);
  });

  it('throws on unknown target kind resolution', () => {
    const reg = new AdapterRegistry();
    expect(() => reg.getTarget('missing')).toThrow(/not registered/);
  });

  describe('§8.2 cleanup invariant', () => {
    it('rejects supportsSourceCleanup=true without cleanup adapter', () => {
      const reg = new AdapterRegistry();
      const adapter = fakeSource('1.0.0', '1.0.0', 'cleaner');
      // mutate capabilities to declare cleanup without providing adapter
      const caps = adapter.capabilities as {
        supportsSourceCleanup: boolean;
        cleanupActions: readonly string[];
      };
      caps.supportsSourceCleanup = true;
      // replace the readonly array; cast bypasses readonly for test fixture
      Object.assign(caps, { cleanupActions: ['unfavorite'] });
      // cleanup is still undefined
      expect(() => reg.registerSource(adapter)).toThrow(
        /supportsSourceCleanup=true but provides no cleanup/,
      );
    });

    it('rejects supportsSourceCleanup=false but cleanupActions non-empty', () => {
      const reg = new AdapterRegistry();
      const adapter = fakeSource('1.0.0', '1.0.0', 'liar');
      Object.assign(adapter.capabilities, { cleanupActions: ['unfavorite'] });
      expect(() => reg.registerSource(adapter)).toThrow(
        /supportsSourceCleanup=false but lists cleanupActions/,
      );
    });

    it('rejects supportsSourceCleanup=false but cleanup adapter present', () => {
      const reg = new AdapterRegistry();
      const adapter = fakeSource('1.0.0', '1.0.0', 'misconfigured') as {
        cleanup?: unknown;
      } & SourceAdapter;
      // attach a cleanup adapter despite capability=false
      adapter.cleanup = {
        supportedActions: ['unfavorite'],
        inspectActionState: async () => ({ state: 'unknown' }),
        executeAction: async () => ({ success: false }),
        verifyAction: async () => ({ verified: false }),
      };
      expect(() => reg.registerSource(adapter)).toThrow(
        /supportsSourceCleanup=false but provides a cleanup adapter/,
      );
    });

    it('accepts a coherent supportsSourceCleanup=true adapter', () => {
      const reg = new AdapterRegistry();
      const adapter = fakeSource('1.0.0', '1.0.0', 'proper') as {
        cleanup?: unknown;
      } & SourceAdapter;
      Object.assign(adapter.capabilities, {
        supportsSourceCleanup: true,
        cleanupActions: ['unfavorite'],
      });
      adapter.cleanup = {
        supportedActions: ['unfavorite'],
        inspectActionState: async () => ({ state: 'unknown' }),
        executeAction: async () => ({ success: false }),
        verifyAction: async () => ({ verified: false }),
      };
      expect(() => reg.registerSource(adapter)).not.toThrow();
      expect(reg.getSource('proper').capabilities.supportsSourceCleanup).toBe(
        true,
      );
    });
  });
});
