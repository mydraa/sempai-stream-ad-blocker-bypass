(function (root) {
  'use strict';

  /**
   * Centralized DOM selectors and structural heuristics for Senpai Stream.
   * Primary selectors reflect the structure observed on https://senpai-stream.link/.
   * Update this file first if Senpai Stream changes class names or element IDs.
   */
  const SELECTORS = Object.freeze({
    gateCard: [
      '[data-relay-state]',
      '[wire\\:snapshot*="ad-gate"]',
      '#adgate-card'
    ],
    counter: [
      '#adgate-counter',
      '[data-adgate-counter]'
    ],
    barsContainer: [
      '#adgate-bars'
    ],
    barItems: [
      '#adgate-bars > span[data-index]',
      '#adgate-bars > span'
    ],
    continueButton: [
      '#adgate-continue',
      'a[href*="/go/"][target="_blank"]',
      '[data-adgate-continue]'
    ],
    howto: [
      '#adgate-howto'
    ],
    status: [
      '#adgate-status'
    ],
    notice: [
      '#adgate-notice'
    ],
    reloadLink: [
      '#adgate-lien'
    ],
    timerContainer: [
      '#adgate-timer'
    ],
    timerValue: [
      '#adgate-timer-value'
    ],
    timerLabel: [
      '#adgate-timer-label'
    ],
    player: [
      'media-player',
      '[x-ref="player"]',
      'media-provider video',
      'video',
      'iframe[src*="player"]',
      'iframe[src*="embed"]'
    ],
    unlockedOverlay: [
      '[x-show="!unlocked"]'
    ],
    unlockedRoot: [
      '[x-data*="unlocked"]'
    ],
    brandMarkers: [
      'a[href*="/play-episode/"]',
      'a[href*="/tv/"]',
      'a[href="/register"]',
      '[wire\\:id]',
      'media-player'
    ]
  });

  const PATTERNS = Object.freeze({
    gateHeading: /(\d+)\s*publicit[eé]s?\s*[àa]\s*passer/i,
    counter: /^\s*(\d+)\s*\/\s*(\d+)\s*$/,
    continueText: /\bcontinuer\b/i,
    expiredText: /(session\s*expir[eé]e|page\s*expir[eé]e|recharger\s*la\s*page|actualiser)/i,
    tooFastText: /(trop\s*t[oô]t|trop\s*vite|retourne\s*sur\s*la\s*publicit[eé]|encore\s*\d+\s*s)/i,
    adblockText: /(bloqueur|ferm[eé]e?\s*trop\s*vite|auto[- ]?ferm[eé])/i,
    brandTitle: /senpai[- ]?stream/i,
    safeGoPath: /\/go\/[a-z0-9_-]+/i
  });

  root.SenpaiSelectors = Object.freeze({
    SELECTORS,
    PATTERNS
  });
})(globalThis);
