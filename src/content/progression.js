(function (root) {
  'use strict';

  /**
   * Manages MutationObserver-driven DOM monitoring and single-flight step activation.
   */
  function createProgressionController(doc, options = {}) {
    const detector = options.detector || root.SenpaiDetector;
    const selectors = options.selectors || root.SenpaiSelectors;
    const { PAGE_KINDS } = root.SenpaiProtocol;

    const onSnapshot = typeof options.onSnapshot === 'function' ? options.onSnapshot : () => {};
    let observer = null;
    let debounceTimer = null;
    let lastSignature = null;
    let lastClickTimestamp = 0;

    function buildSignature(snap) {
      return JSON.stringify([
        snap.pageKind,
        snap.domVerified,
        snap.gateVisible,
        snap.playerReady,
        snap.done,
        snap.required,
        snap.ctaPresent,
        snap.ctaVisible,
        snap.ctaDisabled,
        snap.ctaHref,
        snap.statusText,
        snap.timerSeconds,
        snap.isExpired,
        snap.reloadSuggested
      ]);
    }

    function evaluateAndEmit(force = false) {
      const snapshot = detector.inspectDocument(doc);
      const signature = buildSignature(snapshot);
      if (force || signature !== lastSignature) {
        lastSignature = signature;
        onSnapshot(snapshot);
      }
      return snapshot;
    }

    function scheduleEvaluation() {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        evaluateAndEmit(false);
      }, 45);
    }

    function startObserving() {
      if (observer) return evaluateAndEmit(true);

      const ObserverCtor = doc.defaultView?.MutationObserver || root.MutationObserver;
      if (typeof ObserverCtor === 'function' && doc.body) {
        observer = new ObserverCtor(() => {
          scheduleEvaluation();
        });
        observer.observe(doc.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['style', 'class', 'hidden', 'href', 'disabled', 'aria-disabled', 'data-relay-state']
        });
      }

      return evaluateAndEmit(true);
    }

    function stopObserving() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }

    function findContinueElement() {
      for (const selector of selectors.SELECTORS.continueButton) {
        try {
          const el = doc.querySelector(selector);
          if (el && detector.isElementVisible(el)) return el;
        } catch {
          // Ignore invalid selector
        }
      }
      const fallback = Array.from(doc.querySelectorAll('a, button')).find(
        (node) => detector.isElementVisible(node) && selectors.PATTERNS.continueText.test((node.textContent || '').trim())
      );
      return fallback || null;
    }

    /**
     * Triggers exactly one click on the verified Continue button.
     * Refuses to click if DOM progressed past expectedDone, if locked, or if unsafe.
     */
    function triggerContinueStep(expectedDone) {
      const now = Date.now();
      if (now - lastClickTimestamp < 500) {
        return { ok: false, clicked: false, reason: 'DOUBLE_CLICK_BLOCKED' };
      }

      const snapshot = detector.inspectDocument(doc);
      if (snapshot.pageKind !== PAGE_KINDS.AD_GATE) {
        return {
          ok: false,
          clicked: false,
          reason: snapshot.playerReady ? 'ALREADY_COMPLETED' : 'GATE_NOT_READY',
          snapshot
        };
      }

      if (typeof expectedDone === 'number' && typeof snapshot.done === 'number' && snapshot.done > expectedDone) {
        return {
          ok: false,
          clicked: false,
          reason: 'STEP_ALREADY_PROGRESSED',
          snapshot
        };
      }

      if (snapshot.isExpired) {
        return { ok: false, clicked: false, reason: 'SESSION_EXPIRED', snapshot };
      }

      if (snapshot.timerSeconds && snapshot.timerSeconds > 0) {
        return {
          ok: false,
          clicked: false,
          reason: 'SITE_COOLDOWN_ACTIVE',
          timerSeconds: snapshot.timerSeconds,
          snapshot
        };
      }

      const ctaEl = findContinueElement();
      if (!ctaEl || snapshot.ctaDisabled || !snapshot.ctaSafe) {
        return {
          ok: false,
          clicked: false,
          reason: !snapshot.ctaSafe ? 'UNSAFE_CTA_TARGET' : 'CTA_UNAVAILABLE',
          snapshot
        };
      }

      lastClickTimestamp = now;
      ctaEl.click();

      return {
        ok: true,
        clicked: true,
        href: ctaEl.getAttribute('href') || null,
        snapshot
      };
    }

    return {
      startObserving,
      stopObserving,
      evaluateAndEmit,
      triggerContinueStep
    };
  }

  root.SenpaiProgression = Object.freeze({
    createProgressionController
  });
})(globalThis);
