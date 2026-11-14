(function (root) {
  'use strict';

  if (root.__SENPAI_CONTENT_ACTIVE__) {
    return;
  }
  root.__SENPAI_CONTENT_ACTIVE__ = true;

  const { MSG } = root.SenpaiProtocol;
  const controller = root.SenpaiProgression.createProgressionController(document, {
    onSnapshot: (snapshot) => {
      try {
        chrome.runtime.sendMessage({
          type: MSG.DOM_SNAPSHOT,
          snapshot
        }).catch(() => {});
      } catch {
        // Extension context invalidated on update/reload
      }
    }
  });

  const initialSnapshot = controller.startObserving();

  try {
    chrome.runtime.sendMessage({
      type: MSG.CONTENT_READY,
      snapshot: initialSnapshot
    }).catch(() => {});
  } catch {
    // Ignore when SW is unreachable
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === MSG.PING || message.type === MSG.REQUEST_DOM_SNAPSHOT) {
      const snapshot = controller.evaluateAndEmit(true);
      sendResponse({ ok: true, snapshot });
      return false;
    }

    if (message.type === MSG.TRIGGER_AD_STEP) {
      const result = controller.triggerContinueStep(message.expectedDone);
      sendResponse(result);
      return false;
    }
  });

  window.addEventListener('pagehide', () => {
    controller.stopObserving();
    root.__SENPAI_CONTENT_ACTIVE__ = false;
  });
})(globalThis);
