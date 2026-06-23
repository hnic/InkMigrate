import { describe, it, expect } from 'vitest';
import { detectFavoriteState } from '../../src/cleanup/state-detector.js';
import { loadCleanupFixture } from '../helpers/fixtures.js';

describe('detectFavoriteState (§14.8)', () => {
  it('returns favorited from favorited-article fixture', () => {
    expect(detectFavoriteState(loadCleanupFixture('favorited-article'))).toBe('favorited');
  });
  it('returns not_favorited from not-favorited-article fixture', () => {
    expect(detectFavoriteState(loadCleanupFixture('not-favorited-article'))).toBe('not_favorited');
  });
  it('returns unknown from ambiguous-button-state fixture', () => {
    expect(detectFavoriteState(loadCleanupFixture('ambiguous-button-state'))).toBe('unknown');
  });
  it('returns login_required', () => {
    expect(detectFavoriteState('<div data-testid="login-required">请登录</div>')).toBe('login_required');
  });
  it('returns challenge_required', () => {
    expect(detectFavoriteState('<div data-testid="security-challenge">安全验证</div>')).toBe('challenge_required');
  });
  it('returns content_unavailable', () => {
    expect(detectFavoriteState('<div data-testid="content-deleted">内容不存在</div>')).toBe('content_unavailable');
  });
});
