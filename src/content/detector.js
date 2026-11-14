(function (root) {
  'use strict';

  function getProtocol() {
    return root.SenpaiProtocol;
  }

  function getSelectors() {
    return root.SenpaiSelectors;
  }

  function queryFirst(doc, selectorList) {
    for (const selector of selectorList) {
      try {
        const el = doc.querySelector(selector);
        if (el) return { el, selector };
      } catch {
        // Ignore invalid selector in older DOM engines
      }
    }
    return { el: null, selector: null };
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const win = el.ownerDocument?.defaultView || root;
    let current = el;
    while (current && current.nodeType === 1) {
      if (current.hasAttribute('hidden')) return false;
      const inlineStyle = current.getAttribute('style') || '';
      if (/display\s*:\s*none/i.test(inlineStyle) || /visibility\s*:\s*hidden/i.test(inlineStyle)) {
        return false;
      }
      if (typeof win.getComputedStyle === 'function') {
        const style = win.getComputedStyle(current);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) {
          return false;
        }
      }
      current = current.parentElement;
    }
    return true;
  }

  function parseLivewireSnapshot(doc) {
    const nodes = doc.querySelectorAll('[wire\\:snapshot]');
    for (const node of nodes) {
      const raw = node.getAttribute('wire:snapshot');
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.memo?.name === 'ad-gate' && parsed?.data) {
          return {
            componentId: node.getAttribute('wire:id') || null,
            done: typeof parsed.data.done === 'number' ? parsed.data.done : null,
            required: typeof parsed.data.required === 'number' ? parsed.data.required : null,
            unlocked: typeof parsed.data.unlocked === 'boolean' ? parsed.data.unlocked : null,
            passId: parsed.data.passId ?? null
          };
        }
      } catch {
        // Ignore malformed snapshot JSON
      }
    }
    return null;
  }

  function findHeadingCount(doc, pattern) {
    const candidates = doc.querySelectorAll('h1, h2, h3, p, div');
    for (const node of candidates) {
      if (node.children.length > 2) continue;
      const text = (node.textContent || '').trim();
      if (!text || text.length > 80) continue;
      const match = text.match(pattern);
      if (match) {
        return { text, required: Number(match[1]) };
      }
    }
    return null;
  }

  function findContinueFallback(doc, pattern) {
    const buttons = doc.querySelectorAll('a, button');
    for (const node of buttons) {
      if (!isElementVisible(node)) continue;
      const text = (node.textContent || '').trim();
      if (pattern.test(text)) {
        return node;
      }
    }
    return null;
  }

  function countCompletedBars(doc, barSelectors) {
    for (const selector of barSelectors) {
      const bars = doc.querySelectorAll(selector);
      if (bars.length > 0) {
        let completed = 0;
        for (const bar of bars) {
          const cls = bar.className || '';
          if (
            typeof cls === 'string' &&
            (/\bbg-primary\b|\bbg-primary-|\bbg-emerald|\bbg-green|\bis-done\b|\bcompleted\b/i.test(cls)) &&
            !/bg-white\/10/i.test(cls)
          ) {
            completed++;
          }
        }
        return { completed, total: bars.length };
      }
    }
    return null;
  }

  function isSafeContinueHref(href, docLocation, patterns) {
    if (!href) return true; // Button-based CTA without href in fallback layouts
    try {
      const base = docLocation?.href || 'https://senpai-stream.link/';
      const resolved = new URL(href, base);
      if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return false;
      // Same origin /go/... link or explicit /go/ token route
      const sameOrigin = docLocation?.origin ? resolved.origin === docLocation.origin : true;
      return sameOrigin && patterns.safeGoPath.test(resolved.pathname);
    } catch {
      return false;
    }
  }

  /**
   * Inspects a Document and returns a normalized state snapshot.
   * Never executes clicks or mutates the DOM.
   * @param {Document} doc
   */
  function inspectDocument(doc) {
    const { PAGE_KINDS } = getProtocol();
    const { SELECTORS, PATTERNS } = getSelectors();

    const matchedSelectors = [];
    const livewire = parseLivewireSnapshot(doc);
    if (livewire) matchedSelectors.push('[wire:snapshot="ad-gate"]');

    const gateCardMatch = queryFirst(doc, SELECTORS.gateCard);
    if (gateCardMatch.selector) matchedSelectors.push(gateCardMatch.selector);

    const counterMatch = queryFirst(doc, SELECTORS.counter);
    if (counterMatch.selector) matchedSelectors.push(counterMatch.selector);

    const barsMatch = queryFirst(doc, SELECTORS.barsContainer);
    if (barsMatch.selector) matchedSelectors.push(barsMatch.selector);

    const howtoMatch = queryFirst(doc, SELECTORS.howto);
    if (howtoMatch.selector) matchedSelectors.push(howtoMatch.selector);

    let continueMatch = queryFirst(doc, SELECTORS.continueButton);
    if (continueMatch.selector) matchedSelectors.push(continueMatch.selector);

    const headingInfo = findHeadingCount(doc, PATTERNS.gateHeading);
    if (headingInfo) matchedSelectors.push('text:publicites-a-passer');

    if (!continueMatch.el && (gateCardMatch.el || counterMatch.el || headingInfo)) {
      const fallbackBtn = findContinueFallback(doc, PATTERNS.continueText);
      if (fallbackBtn) {
        continueMatch = { el: fallbackBtn, selector: 'text:Continuer' };
        matchedSelectors.push('text:Continuer');
      }
    }

    const statusMatch = queryFirst(doc, SELECTORS.status);
    const noticeMatch = queryFirst(doc, SELECTORS.notice);
    const reloadMatch = queryFirst(doc, SELECTORS.reloadLink);
    const timerContainerMatch = queryFirst(doc, SELECTORS.timerContainer);
    const timerValueMatch = queryFirst(doc, SELECTORS.timerValue);
    const playerMatch = queryFirst(doc, SELECTORS.player);
    const unlockedOverlayMatch = queryFirst(doc, SELECTORS.unlockedOverlay);

    // Parse counter done / required
    let done = null;
    let required = null;
    if (counterMatch.el) {
      const rawCounter = (counterMatch.el.textContent || '').trim();
      const m = rawCounter.match(PATTERNS.counter);
      if (m) {
        done = Number(m[1]);
        required = Number(m[2]);
      }
    }

    if (done === null || required === null) {
      const barsInfo = countCompletedBars(doc, SELECTORS.barItems);
      if (barsInfo) {
        if (done === null) done = barsInfo.completed;
        if (required === null) required = barsInfo.total;
      }
    }

    if (done === null && livewire?.done !== null && livewire?.done !== undefined) {
      done = livewire.done;
    }
    if (required === null && livewire?.required !== null && livewire?.required !== undefined) {
      required = livewire.required;
    }
    if (required === null && headingInfo) {
      required = headingInfo.required;
    }

    const statusText = [
      statusMatch.el ? (statusMatch.el.textContent || '').trim() : '',
      noticeMatch.el ? (noticeMatch.el.textContent || '').trim() : ''
    ]
      .filter(Boolean)
      .join(' | ');

    let timerSeconds = null;
    if (timerContainerMatch.el && isElementVisible(timerContainerMatch.el) && timerValueMatch.el) {
      const parsedTimer = parseInt((timerValueMatch.el.textContent || '').trim(), 10);
      if (Number.isFinite(parsedTimer) && parsedTimer > 0) {
        timerSeconds = parsedTimer;
      }
    }

    const reloadSuggested = Boolean(reloadMatch.el && isElementVisible(reloadMatch.el));
    const isExpired = reloadSuggested || PATTERNS.expiredText.test(statusText);
    const isTooFastWarning = PATTERNS.tooFastText.test(statusText) || timerSeconds !== null;
    const isAdblockWarning = PATTERNS.adblockText.test(statusText);

    const gateSurfaceEl = gateCardMatch.el || counterMatch.el || continueMatch.el;
    const overlayHidden = unlockedOverlayMatch.el ? !isElementVisible(unlockedOverlayMatch.el) : false;
    const gateVisible = Boolean(gateSurfaceEl && isElementVisible(gateSurfaceEl) && !overlayHidden);

    const ctaEl = continueMatch.el;
    const ctaHref = ctaEl?.getAttribute?.('href') || null;
    const ctaDisabled = Boolean(
      !ctaEl ||
        ctaEl.hasAttribute('disabled') ||
        ctaEl.getAttribute('aria-disabled') === 'true'
    );
    const ctaVisible = Boolean(ctaEl && isElementVisible(ctaEl));
    const ctaSafe = isSafeContinueHref(ctaHref, doc.location, PATTERNS);

    const playerPresent = Boolean(playerMatch.el);
    const playerVisible = Boolean(playerMatch.el && isElementVisible(playerMatch.el));
    if (playerMatch.selector) matchedSelectors.push(playerMatch.selector);

    const hasAdGateStructure = Boolean(
      (counterMatch.el && (barsMatch.el || howtoMatch.el || continueMatch.el || headingInfo)) ||
      (gateCardMatch.el && (counterMatch.el || continueMatch.el)) ||
      (livewire !== null)
    );

    const unlockedByCount =
      typeof done === 'number' && typeof required === 'number' && required > 0 && done >= required;
    const unlockedFlag = livewire?.unlocked === true || overlayHidden || unlockedByCount;

    let brandDetected = hasAdGateStructure || playerPresent || PATTERNS.brandTitle.test(doc.title || '');
    if (!brandDetected) {
      for (const sel of SELECTORS.brandMarkers) {
        if (doc.querySelector(sel)) {
          brandDetected = true;
          matchedSelectors.push(sel);
          break;
        }
      }
    }

    let pageKind = PAGE_KINDS.UNKNOWN;
    if (hasAdGateStructure && gateVisible && !unlockedByCount && livewire?.unlocked !== true) {
      pageKind = PAGE_KINDS.AD_GATE;
    } else if ((playerPresent && (unlockedFlag || !gateVisible)) || (hasAdGateStructure && unlockedFlag)) {
      pageKind = PAGE_KINDS.PLAYER_UNLOCKED;
    } else if (brandDetected) {
      pageKind = PAGE_KINDS.SITE_HOME_OR_OTHER;
    }

    const domVerified = pageKind !== PAGE_KINDS.UNKNOWN;

    return {
      url: doc.location?.href || '',
      origin: doc.location?.origin || '',
      pageKind,
      domVerified,
      hasAdGateStructure,
      gateVisible,
      playerPresent,
      playerReady: pageKind === PAGE_KINDS.PLAYER_UNLOCKED && (playerVisible || unlockedFlag),
      done,
      required,
      passId: livewire?.passId ?? null,
      relayState: gateCardMatch.el?.getAttribute?.('data-relay-state') || null,
      ctaPresent: Boolean(ctaEl),
      ctaVisible,
      ctaDisabled,
      ctaSafe,
      ctaHref,
      statusText,
      timerSeconds,
      isExpired,
      isTooFastWarning,
      isAdblockWarning,
      reloadSuggested,
      matchedSelectors: Array.from(new Set(matchedSelectors)),
      observedAt: Date.now()
    };
  }

  root.SenpaiDetector = Object.freeze({
    isElementVisible,
    inspectDocument
  });
})(globalThis);
