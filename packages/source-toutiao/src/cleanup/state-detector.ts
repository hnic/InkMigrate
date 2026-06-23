import { JSDOM } from 'jsdom';

export type FavoriteState =
  | 'favorited'
  | 'not_favorited'
  | 'unknown'
  | 'login_required'
  | 'challenge_required'
  | 'content_unavailable';

/** §14.8 从页面 HTML 检测收藏状态。 */
export function detectFavoriteState(html: string): FavoriteState {
  const dom = new JSDOM(html, { runScripts: 'outside-only', resources: undefined });
  const doc = dom.window.document;

  if (doc.querySelector('[data-testid="login-required"]')) return 'login_required';
  if (doc.querySelector('[data-testid="security-challenge"]')) return 'challenge_required';
  if (doc.querySelector('[data-testid="content-deleted"]')) return 'content_unavailable';

  const btn = doc.querySelector('[data-testid="favorite-button"]');
  if (!btn) return 'unknown';

  const pressed = btn.getAttribute('aria-pressed');
  if (pressed === 'true') return 'favorited';
  if (pressed === 'false') return 'not_favorited';
  return 'unknown';
}
