import { JSDOM } from 'jsdom';

export interface VerificationResult {
  verified: boolean;
  strongSignal: boolean;
  auxiliarySignal: boolean;
}

/** §14.10 操作后复核。 */
export function verifyUnfavoriteResult(html: string): VerificationResult {
  const dom = new JSDOM(html, { runScripts: 'outside-only', resources: undefined });
  const doc = dom.window.document;
  const btn = doc.querySelector('[data-testid="favorite-button"]');
  const pressed = btn?.getAttribute('aria-pressed');
  const strongSignal = pressed === 'false';
  const auxiliarySignal = doc.querySelector('[data-testid="unfavorite-success"]') !== null;
  return { verified: strongSignal, strongSignal, auxiliarySignal };
}
