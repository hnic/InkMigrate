import { JSDOM } from 'jsdom';
import { UNFAVORITE_SELECTORS } from '../selectors/index.js';

export interface VerificationResult {
  verified: boolean;
  strongSignal: boolean;
  auxiliarySignal: boolean;
}

/** §14.10 操作后复核。 */
export function verifyUnfavoriteResult(html: string): VerificationResult {
  const dom = new JSDOM(html, { runScripts: 'outside-only', resources: undefined });
  const doc = dom.window.document;
  const btn = doc.querySelector(UNFAVORITE_SELECTORS.collectButton[0]);
  const pressed = btn?.getAttribute('aria-pressed');
  const strongSignal = pressed === UNFAVORITE_SELECTORS.notFavoritedAriaPressed;
  const auxiliarySignal = doc.querySelector(UNFAVORITE_SELECTORS.successMarker[0]) !== null;
  return { verified: strongSignal, strongSignal, auxiliarySignal };
}
