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
  // R1: collectButton / successMarker 用全部选择器 join（L8 漏了此处），
  // 与 unfavorite-driver / state-detector 一致。
  const btn = doc.querySelector(UNFAVORITE_SELECTORS.collectButton.join(', '));
  const pressed = btn?.getAttribute('aria-pressed');
  const strongSignal = pressed === UNFAVORITE_SELECTORS.notFavoritedAriaPressed;
  const auxiliarySignal =
    doc.querySelector(UNFAVORITE_SELECTORS.successMarker.join(', ')) !== null;
  return { verified: strongSignal, strongSignal, auxiliarySignal };
}
