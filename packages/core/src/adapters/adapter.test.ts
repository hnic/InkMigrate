import { describe, it, expect } from 'vitest';
import type { TargetPlan, TargetContext } from './adapter.js';
import { ARTIFACT_KINDS, isArtifactKind } from '../domain/states.js';

describe('target adapter contract (stage 2 core extensions)', () => {
  it('TargetPlan.artifactKind is constrained to ArtifactKind', () => {
    const plan: TargetPlan = {
      relativePath: 'a.md',
      artifactKind: 'note',
    };
    expect(isArtifactKind(plan.artifactKind)).toBe(true);
  });

  it('ARTIFACT_KINDS covers note/note_variant/index/report/manifest', () => {
    expect(ARTIFACT_KINDS).toEqual([
      'note',
      'note_variant',
      'index',
      'report',
      'manifest',
    ]);
  });

  it('TargetContext exposes targetConfig for runtime config access', () => {
    const ctx: TargetContext = {
      config: {},
      workspaceDir: '.',
      vaultPath: '/vault',
      targetConfig: { linkStyle: 'wikilink' },
    };
    expect(ctx.targetConfig.linkStyle).toBe('wikilink');
  });

  it('TargetContext.targetConfig is required (not optional)', () => {
    // @ts-expect-error — targetConfig missing must be a compile error
    const bad: TargetContext = {
      config: {},
      workspaceDir: '.',
      vaultPath: '/vault',
    };
    void bad;
  });
});
