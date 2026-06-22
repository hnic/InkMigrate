import { describe, it, expect } from 'vitest';
import {
  loadConfigFromString,
  ConfigValidationError,
} from './loader.js';

describe('config loader (§10.3)', () => {
  it('parses a minimal valid config', () => {
    const cfg = loadConfigFromString(`
version: 1
workspace:
  stateDir: ".inkmigrate"
sources: []
targets: []
`);
    expect(cfg.version).toBe(1);
    expect(cfg.workspace.stateDir).toBe('.inkmigrate');
    expect(cfg.sources).toEqual([]);
    expect(cfg.targets).toEqual([]);
    // defaults
    expect(cfg.sourceCleanup.enabled).toBe(false);
    expect(cfg.privacy.telemetry).toBe(false);
    expect(cfg.privacy.redactLogs).toBe(true);
  });

  it('rejects unknown top-level field by default (§10.3 未知字段默认报错)', () => {
    expect(() =>
      loadConfigFromString(`version: 1\nworkspace:\n  stateDir: ".inkmigrate"\nweird: 1\n`),
    ).toThrow(ConfigValidationError);
  });

  it('rejects unsupported version', () => {
    let thrown: unknown;
    try {
      loadConfigFromString(`version: 2\nworkspace:\n  stateDir: ".inkmigrate"\n`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).errors.some((m) => /version/i.test(m))).toBe(true);
  });

  it('requires workspace.stateDir', () => {
    let thrown: unknown;
    try {
      loadConfigFromString(`version: 1\nworkspace: {}\n`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    expect((thrown as ConfigValidationError).errors.some((m) => /stateDir/i.test(m))).toBe(true);
  });

  it('aggregates duplicate source AND target IDs in one error (§10.3 一次性列出全部错误)', () => {
    let thrown: unknown;
    try {
      loadConfigFromString(`
version: 1
workspace:
  stateDir: ".inkmigrate"
sources:
  - id: dup
    adapter: toutiao
  - id: dup
    adapter: toutiao
targets:
  - id: dup
    adapter: obsidian
  - id: dup
    adapter: obsidian
`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const errs = (thrown as ConfigValidationError).errors.join('\n');
    expect(errs).toMatch(/sources: duplicate id "dup"/);
    expect(errs).toMatch(/targets: duplicate id "dup"/);
  });

  it('aggregates multiple distinct schema errors, not just the first', () => {
    let thrown: unknown;
    try {
      loadConfigFromString(`
version: 1
workspace:
  stateDir: ".inkmigrate"
sources:
  - id: s1
    adapter: toutiao
    enabled: "not-a-bool"
  - id: s1
    adapter: toutiao
`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
    const errs = (thrown as ConfigValidationError).errors;
    // both the type error AND the duplicate-id error should be present
    expect(errs.length).toBeGreaterThan(1);
    expect(errs.some((e) => /duplicate/i.test(e))).toBe(true);
    expect(errs.some((e) => /enabled/i.test(e))).toBe(true);
  });

  it('sourceCleanup defaults to enabled=false even if section omitted', () => {
    const cfg = loadConfigFromString(`version: 1\nworkspace:\n  stateDir: ".inkmigrate"\n`);
    expect(cfg.sourceCleanup.enabled).toBe(false);
  });

  it('all privacy defaults are populated when section omitted', () => {
    const cfg = loadConfigFromString(`version: 1\nworkspace:\n  stateDir: ".inkmigrate"\n`);
    expect(cfg.privacy.telemetry).toBe(false);
    expect(cfg.privacy.redactLogs).toBe(true);
    expect(cfg.privacy.retainFailureScreenshots).toBe(true);
    expect(cfg.privacy.saveSanitizedHtml).toBe(true);
  });

  it('non-array sources (e.g. wrong YAML type) yields ConfigValidationError, not raw TypeError', () => {
    let thrown: unknown;
    try {
      loadConfigFromString(`
version: 1
workspace:
  stateDir: ".inkmigrate"
sources: "this should be an array"
`);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigValidationError);
  });
});
