import { describe, it, expect } from 'vitest';
import { decideOverwrite } from '../src/overwrite-policy.js';
import type { ObsidianTargetConfig } from '../src/config.js';

const cfg = (
  overwritePolicy: ObsidianTargetConfig['overwritePolicy'],
): ObsidianTargetConfig => ({
  vaultPath: '/v',
  importSubdir: 'Imports/InkMigrate',
  attachmentsSubdir: 'Attachments/InkMigrate',
  linkStyle: 'wikilink',
  overwritePolicy,
  collectionMapping: { toTags: false, toFolders: false },
  maxFilenameLength: 100,
});

describe('decideOverwrite (§13.9 策略矩阵)', () => {
  it('target does not exist → write_canonical regardless of policy', () => {
    for (const policy of [
      'preserve',
      'replace',
      'write-new',
      'metadata-only',
    ] as const) {
      const d = decideOverwrite({
        config: cfg(policy),
        targetExists: false,
        userModified: false,
        isMetadataOnlyUpdate: false,
      });
      expect(d.action).toBe('write_canonical');
    }
  });

  describe('target exists, not user-modified', () => {
    it('preserve → write_canonical (atomic update)', () => {
      expect(
        decideOverwrite({
          config: cfg('preserve'),
          targetExists: true,
          userModified: false,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('write_canonical');
    });
    it('replace → write_canonical', () => {
      expect(
        decideOverwrite({
          config: cfg('replace'),
          targetExists: true,
          userModified: false,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('write_canonical');
    });
    it('write-new → write_canonical (NOT a new variant file)', () => {
      const d = decideOverwrite({
        config: cfg('write-new'),
        targetExists: true,
        userModified: false,
        isMetadataOnlyUpdate: false,
      });
      expect(d.action).toBe('write_canonical');
    });
    it('metadata-only → update_metadata_only', () => {
      expect(
        decideOverwrite({
          config: cfg('metadata-only'),
          targetExists: true,
          userModified: false,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('update_metadata_only');
    });
  });

  describe('target exists, user-modified', () => {
    it('preserve → mark_conflict', () => {
      expect(
        decideOverwrite({
          config: cfg('preserve'),
          targetExists: true,
          userModified: true,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('mark_conflict');
    });
    it('replace → forced_overwrite', () => {
      expect(
        decideOverwrite({
          config: cfg('replace'),
          targetExists: true,
          userModified: true,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('forced_overwrite');
    });
    it('write-new → write_new_variant', () => {
      expect(
        decideOverwrite({
          config: cfg('write-new'),
          targetExists: true,
          userModified: true,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('write_new_variant');
    });
    it('metadata-only → mark_conflict (cannot do body update)', () => {
      expect(
        decideOverwrite({
          config: cfg('metadata-only'),
          targetExists: true,
          userModified: true,
          isMetadataOnlyUpdate: false,
        }).action,
      ).toBe('mark_conflict');
    });
  });

  it('forced_overwrite decision carries evidence fields for audit', () => {
    const d = decideOverwrite({
      config: cfg('replace'),
      targetExists: true,
      userModified: true,
      isMetadataOnlyUpdate: false,
      expectedWrittenFileHash: 'sha256:old',
      observedPrewriteFileHash: 'sha256:current',
    });
    expect(d.action).toBe('forced_overwrite');
    expect(d.requiresForcedOverwriteAudit).toBe(true);
    expect(d.expectedWrittenFileHash).toBe('sha256:old');
    expect(d.observedPrewriteFileHash).toBe('sha256:current');
  });

  it('write_new_variant decision carries observedPrewriteFileHash', () => {
    const d = decideOverwrite({
      config: cfg('write-new'),
      targetExists: true,
      userModified: true,
      isMetadataOnlyUpdate: false,
      observedPrewriteFileHash: 'sha256:current',
    });
    expect(d.action).toBe('write_new_variant');
    expect(d.requiresForcedOverwriteAudit).toBe(false);
    expect(d.artifactKind).toBe('note_variant');
  });

  it('write_canonical decision sets artifactKind=note', () => {
    const d = decideOverwrite({
      config: cfg('preserve'),
      targetExists: false,
      userModified: false,
      isMetadataOnlyUpdate: false,
    });
    expect(d.artifactKind).toBe('note');
  });
});
