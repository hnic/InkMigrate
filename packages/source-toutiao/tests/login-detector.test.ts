import { describe, it, expect } from 'vitest';
import { detectLoginState } from '../src/auth/login-detector.js';

describe('detectLoginState (§12.2 多信号)', () => {
  it('returns logged-in when 2+ independent positive signals agree', () => {
    const state = detectLoginState({
      currentUrlLeftAuthPage: true,
      hasUserEntryElement: true,
    });
    expect(state).toBe('logged-in');
  });

  it('returns not-logged-in when clear negative signals', () => {
    const state = detectLoginState({
      currentUrlLeftAuthPage: false,
      hasLoginMask: true,
      redirectedToLogin: true,
    });
    expect(state).toBe('not-logged-in');
  });

  it('returns auth-state-unknown when signals conflict (§12.2)', () => {
    const state = detectLoginState({
      currentUrlLeftAuthPage: true, // positive
      hasLoginMask: true, // negative
    });
    expect(state).toBe('auth-state-unknown');
  });

  it('returns auth-state-unknown when only cookie-exists signal (§12.2 last bullet)', () => {
    const state = detectLoginState({
      cookieExists: true,
    });
    expect(state).toBe('auth-state-unknown');
  });

  it('returns auth-state-unknown when no signals provided', () => {
    const state = detectLoginState({});
    expect(state).toBe('auth-state-unknown');
  });

  it('treats network-auth-response as a valid independent signal', () => {
    const state = detectLoginState({
      currentUrlLeftAuthPage: true,
      networkAuthResponseOk: true,
    });
    expect(state).toBe('logged-in');
  });

  it('does not require exactly 2 — 3+ positives still logged-in', () => {
    const state = detectLoginState({
      currentUrlLeftAuthPage: true,
      hasUserEntryElement: true,
      favoritesPageAccessible: true,
    });
    expect(state).toBe('logged-in');
  });
});
