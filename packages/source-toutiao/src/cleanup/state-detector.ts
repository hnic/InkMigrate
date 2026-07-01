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

  // L8: 用全部选择器 join（querySelector 支持逗号分隔的 CSS 选择器组），
  // 与 unfavorite-driver 一致，避免真实页面因无 testid 而漏判。
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.loginRequired.join(', '))) return 'login_required';
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.securityChallenge.join(', '))) return 'challenge_required';
  if (doc.querySelector(SPECIAL_PAGE_SELECTORS.contentDeleted.join(', '))) return 'content_unavailable';

  // R1: collectButton 同样用全部选择器 join（L8 漏了此处），避免真实页面
  //（.detail-interaction-collect）因无 testid 而漏判为 unknown。
  const btn = doc.querySelector(UNFAVORITE_SELECTORS.collectButton.join(', '));
  if (!btn) return 'unknown';

  const pressed = btn.getAttribute('aria-pressed');
  if (pressed === UNFAVORITE_SELECTORS.favoritedAriaPressed) return 'favorited';
  if (pressed === UNFAVORITE_SELECTORS.notFavoritedAriaPressed) return 'not_favorited';
  return 'unknown';
}
