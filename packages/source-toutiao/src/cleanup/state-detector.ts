import { JSDOM } from 'jsdom';
import { SPECIAL_PAGE_SELECTORS, UNFAVORITE_SELECTORS } from '../selectors/index.js';

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

  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.loginRequired[0])) return 'login_required';
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.securityChallenge[0])) return 'challenge_required';
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.contentDeleted[0])) return 'content_unavailable';

  const btn = doc.querySelector(UNFAVORITE_SELECTORS.collectButton[0]);
  if (!btn) return 'unknown';

  const pressed = btn.getAttribute('aria-pressed');
  if (pressed === UNFAVORITE_SELECTORS.favoritedAriaPressed) return 'favorited';
  if (pressed === UNFAVORITE_SELECTORS.notFavoritedAriaPressed) return 'not_favorited';
  return 'unknown';
}
