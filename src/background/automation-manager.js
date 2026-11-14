import {
  FOCUS_POLICIES,
  MSG,
  PAGE_KINDS,
  STATES,
  STATE_LABELS_FR,
  TIMING_CONSTANTS
} from '../shared/constants.js';

const ACTIVE_RUN_STATES = new Set([
  STATES.OPENING_AD,
  STATES.WAITING_VALIDATION,
  STATES.RETURNING,
  STATES.NEXT_STEP
]);

/**
 * Persistent state machine coordinating the 5-step ad-gate automation.
 * Authoritative session state is always stored in chrome.storage.session / local,
 * allowing full recovery across MV3 service worker suspension.
 */
export function createAutomationManager({
  storage,
  tabManager,
  logger,
  chromeApi = globalThis.chrome,
  scheduleTimeout = (fn, ms) => setTimeout(fn, ms),
  clearScheduledTimeout = (id) => clearTimeout(id)
}) {
  const tabLocks = new Map();
  const ephemeralTimers = new Map();

  function withTabLock(tabId, task) {
    const key = String(tabId);
    const prev = tabLocks.get(key) || Promise.resolve();
    const next = prev.then(task, task).finally(() => {
      if (tabLocks.get(key) === next) {
        tabLocks.delete(key);
      }
    });
    tabLocks.set(key, next);
    return next;
  }

  function clearTabTimer(tabId) {
    const key = String(tabId);
    const existing = ephemeralTimers.get(key);
    if (existing) {
      clearScheduledTimeout(existing);
      ephemeralTimers.delete(key);
    }
  }

  function setTabTimer(tabId, ms, callback) {
    clearTabTimer(tabId);
    const id = scheduleTimeout(() => {
      ephemeralTimers.delete(String(tabId));
      Promise.resolve(callback()).catch(() => {});
    }, Math.max(0, ms));
    ephemeralTimers.set(String(tabId), id);
  }

  function createBlankSession(tabId, snapshot = {}) {
    return {
      mainTabId: tabId,
      origin: snapshot.origin || '',
      url: snapshot.url || '',
      state: STATES.DETECTING,
      pageKind: snapshot.pageKind || PAGE_KINDS.UNKNOWN,
      domVerified: Boolean(snapshot.domVerified),
      done: typeof snapshot.done === 'number' ? snapshot.done : 0,
      required: typeof snapshot.required === 'number' ? snapshot.required : 5,
      passId: snapshot.passId ?? null,
      stepStartedDone: null,
      currentStepIndex: null,
      adTabId: null,
      adOpenedAt: null,
      adHoldUntil: null,
      stepDeadlineAt: null,
      nextStepAt: null,
      retriesOnCurrentStep: 0,
      totalStepsCompleted: 0,
      autoStartAttempted: false,
      completedPassKey: null,
      pauseReason: null,
      lastError: null,
      lastStatusText: snapshot.statusText || '',
      timerSeconds: snapshot.timerSeconds ?? null,
      updatedAt: Date.now()
    };
  }

  function getPassKey(snapshot) {
    if (!snapshot) return null;
    if (snapshot.passId !== null && snapshot.passId !== undefined) {
      return `pass:${snapshot.passId}`;
    }
    return snapshot.url ? `url:${snapshot.url}` : null;
  }

  async function ensureWatchdogAlarm(active) {
    if (!chromeApi?.alarms) return;
    try {
      if (active) {
        const existing = await chromeApi.alarms.get(TIMING_CONSTANTS.WATCHDOG_ALARM_NAME);
        if (!existing) {
          await chromeApi.alarms.create(TIMING_CONSTANTS.WATCHDOG_ALARM_NAME, {
            periodInMinutes: TIMING_CONSTANTS.WATCHDOG_PERIOD_MINUTES
          });
        }
      } else {
        await chromeApi.alarms.clear(TIMING_CONSTANTS.WATCHDOG_ALARM_NAME);
      }
    } catch {
      // Ignore in mocked environments
    }
  }

  async function syncWatchdogState() {
    const sessions = await storage.getSessions();
    const hasActive = Object.values(sessions).some((s) => ACTIVE_RUN_STATES.has(s.state));
    await ensureWatchdogAlarm(hasActive);
  }

  async function updateBadgeForTab(tabId, session, candidateInfo = null, settings = null) {
    if (!chromeApi?.action?.setBadgeText) return;
    try {
      const cfg = settings || (await storage.getSettings());
      if (!cfg.enabled) {
        await chromeApi.action.setBadgeText({ tabId, text: 'OFF' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#475569' });
        return;
      }

      if (candidateInfo) {
        await chromeApi.action.setBadgeText({ tabId, text: '+' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' });
        return;
      }

      if (!session) {
        await chromeApi.action.setBadgeText({ tabId, text: '' });
        return;
      }

      const ratio = typeof session.done === 'number' && typeof session.required === 'number'
        ? `${session.done}/${session.required}`
        : '';

      if (session.state === STATES.COMPLETED) {
        await chromeApi.action.setBadgeText({ tabId, text: 'OK' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#10b981' });
      } else if (session.state === STATES.ERROR) {
        await chromeApi.action.setBadgeText({ tabId, text: '!' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
      } else if (session.state === STATES.PAUSED_FOCUS) {
        await chromeApi.action.setBadgeText({ tabId, text: '||' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' });
      } else if (ACTIVE_RUN_STATES.has(session.state)) {
        await chromeApi.action.setBadgeText({ tabId, text: ratio || '...' });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' });
      } else if (session.state === STATES.READY) {
        await chromeApi.action.setBadgeText({ tabId, text: ratio });
        await chromeApi.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });
      } else {
        await chromeApi.action.setBadgeText({ tabId, text: '' });
      }
    } catch {
      // Tab may already be closed
    }
  }

  async function notifyUser(id, title, message) {
    if (!chromeApi?.notifications?.create) return;
    try {
      const settings = await storage.getSettings();
      if (!settings.notifyOnComplete) return;
      const iconUrl = chromeApi.runtime?.getURL ? chromeApi.runtime.getURL('icons/icon-128.png') : 'icons/icon-128.png';
      await chromeApi.notifications.create(id, {
        type: 'basic',
        iconUrl,
        title,
        message
      });
    } catch {
      // Notifications may be blocked by OS/policy
    }
  }

  async function markDomainVerification(origin, verified) {
    if (!origin) return;
    const domains = await storage.getAuthorizedDomains();
    const existing = domains.find((d) => d.origin === origin);
    if (!existing) return;
    if (verified && (!existing.domVerified || !existing.lastVerifiedAt)) {
      await storage.upsertAuthorizedDomain({
        ...existing,
        domVerified: true,
        lastVerifiedAt: Date.now()
      });
    }
  }

  async function isDomainEnabledForAutomation(origin) {
    const domains = await storage.getAuthorizedDomains();
    const found = domains.find((d) => d.origin === origin);
    return found ? found.enabled !== false : false;
  }

  async function handleContentSnapshot(tabId, snapshot) {
    return withTabLock(tabId, async () => {
      const settings = await storage.getSettings();
      const sessions = await storage.getSessions();
      let session = sessions[String(tabId)] || createBlankSession(tabId, snapshot);
      const prevState = session.state;
      const prevDone = session.done;

      const passKey = getPassKey(snapshot);
      if (snapshot.passId !== null && session.passId !== null && snapshot.passId !== session.passId) {
        // New episode/pass loaded in same tab
        session = createBlankSession(tabId, snapshot);
      }

      session.origin = snapshot.origin || session.origin;
      session.url = snapshot.url || session.url;
      session.pageKind = snapshot.pageKind;
      session.domVerified = Boolean(snapshot.domVerified);
      session.lastStatusText = snapshot.statusText || '';
      session.timerSeconds = snapshot.timerSeconds ?? null;
      if (typeof snapshot.done === 'number') session.done = snapshot.done;
      if (typeof snapshot.required === 'number') session.required = snapshot.required;
      if (snapshot.passId !== null && snapshot.passId !== undefined) session.passId = snapshot.passId;
      session.updatedAt = Date.now();

      if (snapshot.domVerified && snapshot.origin) {
        await markDomainVerification(snapshot.origin, true);
      }

      if (!settings.enabled) {
        clearTabTimer(tabId);
        await tabManager.disarmOpenExpectation(tabId);
        session.state = STATES.STOPPED;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        await syncWatchdogState();
        return session;
      }

      const domainAllowed = await isDomainEnabledForAutomation(session.origin);
      if (!domainAllowed) {
        clearTabTimer(tabId);
        session.state = STATES.IDLE;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        return session;
      }

      if (!snapshot.domVerified) {
        session.state = STATES.IDLE;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        return session;
      }

      // Case 1: Player unlocked or all required steps done
      if (
        snapshot.pageKind === PAGE_KINDS.PLAYER_UNLOCKED ||
        (snapshot.pageKind === PAGE_KINDS.AD_GATE &&
          typeof snapshot.done === 'number' &&
          typeof snapshot.required === 'number' &&
          snapshot.required > 0 &&
          snapshot.done >= snapshot.required)
      ) {
        clearTabTimer(tabId);
        await tabManager.disarmOpenExpectation(tabId);
        const justFinishedRun = ACTIVE_RUN_STATES.has(prevState) || prevState === STATES.PAUSED_FOCUS;
        if (session.adTabId && settings.autoCloseAdTabs) {
          await tabManager.closeManagedAdTab(session.adTabId);
        }
        session.adTabId = null;
        session.adOpenedAt = null;
        session.adHoldUntil = null;
        session.stepDeadlineAt = null;
        session.nextStepAt = null;
        session.pauseReason = null;
        session.lastError = null;
        session.retriesOnCurrentStep = 0;
        session.completedPassKey = passKey;
        session.state = STATES.COMPLETED;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        await syncWatchdogState();

        if (justFinishedRun) {
          if (settings.focusPolicy === FOCUS_POLICIES.AUTO_SWITCH) {
            await restoreUserTabIfNeeded(tabId);
          }
          await logger.info('AUTO', 'Parcours publicitaire terminé, lecteur prêt', {
            mainTabId: tabId,
            done: session.done,
            required: session.required
          });
          await notifyUser(
            `senpai-done-${tabId}`,
            'Senpai Stream — Lecteur débloqué',
            `Toutes les étapes (${session.done}/${session.required}) sont terminées. Vous pouvez lancer la vidéo.`
          );
        }
        return session;
      }

      // Case 2: Non-watch page on Senpai Stream
      if (snapshot.pageKind === PAGE_KINDS.SITE_HOME_OR_OTHER) {
        clearTabTimer(tabId);
        session.state = STATES.IDLE;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        await syncWatchdogState();
        return session;
      }

      // Case 3: Active ad-gate page
      if (snapshot.isExpired) {
        clearTabTimer(tabId);
        await tabManager.disarmOpenExpectation(tabId);
        session.state = STATES.ERROR;
        session.lastError = 'Session expirée côté site. Rechargez la page puis réessayez.';
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        await syncWatchdogState();
        await logger.error('AUTO', 'Session publicitaire expirée détectée', { mainTabId: tabId });
        return session;
      }

      // If we were waiting for step confirmation (WAITING_VALIDATION or RETURNING)
      if (prevState === STATES.WAITING_VALIDATION || prevState === STATES.RETURNING) {
        const baseline = typeof session.stepStartedDone === 'number' ? session.stepStartedDone : prevDone;
        if (typeof snapshot.done === 'number' && snapshot.done > baseline) {
          clearTabTimer(tabId);
          session.adTabId = null;
          session.adOpenedAt = null;
          session.adHoldUntil = null;
          session.stepDeadlineAt = null;
          session.retriesOnCurrentStep = 0;
          session.lastError = null;
          session.pauseReason = null;
          session.totalStepsCompleted += 1;
          session.state = STATES.NEXT_STEP;

          const extraSiteWaitMs = snapshot.timerSeconds ? snapshot.timerSeconds * 1000 : 0;
          const delayMs = Math.max(settings.interStepDelayMs, extraSiteWaitMs + 300);
          session.nextStepAt = Date.now() + delayMs;

          await storage.saveSession(tabId, session);
          await updateBadgeForTab(tabId, session, null, settings);
          await logger.info('AUTO', 'Étape validée par le site', {
            mainTabId: tabId,
            done: snapshot.done,
            required: snapshot.required
          });

          // If focusPolicy === auto_switch and user was on another tab in this window, switch back between steps
          if (settings.focusPolicy === FOCUS_POLICIES.AUTO_SWITCH) {
            await restoreUserTabIfNeeded(tabId);
          }

          setTabTimer(tabId, delayMs, () => triggerNextStep(tabId));
          return session;
        }

        // Site asked to wait (too_fast countdown)
        if (snapshot.timerSeconds && snapshot.timerSeconds > 0) {
          const waitDeadline = Date.now() + (snapshot.timerSeconds + 4) * 1000;
          if (!session.stepDeadlineAt || waitDeadline > session.stepDeadlineAt) {
            session.stepDeadlineAt = waitDeadline;
            await storage.saveSession(tabId, session);
            setTabTimer(tabId, (snapshot.timerSeconds + 4) * 1000, () => handleStepTimeout(tabId));
          }
          await logger.info('AUTO', 'Délai imposé par le site détecté', {
            mainTabId: tabId,
            timerSeconds: snapshot.timerSeconds
          });
          return session;
        }

        if (snapshot.isAdblockWarning) {
          await storage.saveSession(tabId, session);
          await handleStepFailureLocked(tabId, session, settings, snapshot.statusText || 'Fermeture trop rapide détectée par le site.');
          return session;
        }

        await storage.saveSession(tabId, session);
        return session;
      }

      // Stay stopped/errored/completed/paused unless explicitly resumed
      if (
        prevState === STATES.STOPPED ||
        prevState === STATES.ERROR ||
        prevState === STATES.PAUSED_FOCUS ||
        (prevState === STATES.COMPLETED && session.completedPassKey === passKey) ||
        ACTIVE_RUN_STATES.has(prevState)
      ) {
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        return session;
      }

      // Transition to READY
      session.state = STATES.READY;
      session.lastError = null;
      await storage.saveSession(tabId, session);
      await updateBadgeForTab(tabId, session, null, settings);

      if (settings.autoStart && !session.autoStartAttempted && session.completedPassKey !== passKey) {
        session.autoStartAttempted = true;
        await storage.saveSession(tabId, session);
        setTabTimer(tabId, 250, () => triggerNextStep(tabId));
      }

      return session;
    });
  }

  async function restoreUserTabIfNeeded(mainTabId) {
    const mainTab = await tabManager.getTabSafe(mainTabId);
    if (!mainTab) return;
    const returnMap = await storage.getUserReturnTabs();
    const returnTabId = returnMap[String(mainTab.windowId)];
    if (typeof returnTabId === 'number' && returnTabId !== mainTabId) {
      const targetTab = await tabManager.getTabSafe(returnTabId);
      if (targetTab && targetTab.windowId === mainTab.windowId) {
        await tabManager.activateTab(returnTabId);
      }
      delete returnMap[String(mainTab.windowId)];
      await storage.setUserReturnTabs(returnMap);
    }
  }

  async function triggerNextStep(tabId) {
    return withTabLock(tabId, async () => {
      const settings = await storage.getSettings();
      if (!settings.enabled) return null;

      const sessions = await storage.getSessions();
      const session = sessions[String(tabId)];
      if (!session) return null;

      if (
        session.state === STATES.COMPLETED ||
        session.state === STATES.STOPPED ||
        session.state === STATES.ERROR ||
        session.state === STATES.OPENING_AD ||
        session.state === STATES.WAITING_VALIDATION
      ) {
        return session;
      }

      if (
        typeof session.done === 'number' &&
        typeof session.required === 'number' &&
        session.required > 0 &&
        session.done >= session.required
      ) {
        session.state = STATES.COMPLETED;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        await syncWatchdogState();
        return session;
      }

      const mainTab = await tabManager.getTabSafe(tabId);
      if (!mainTab) {
        await storage.saveSession(tabId, null);
        await syncWatchdogState();
        return null;
      }

      // Respectful focus check in the same window
      const activeTab = await tabManager.getActiveTabInWindow(mainTab.windowId);
      if (activeTab && activeTab.id !== tabId && activeTab.id !== session.adTabId) {
        if (settings.focusPolicy === FOCUS_POLICIES.RESPECTFUL) {
          session.state = STATES.PAUSED_FOCUS;
          session.pauseReason = 'USER_ON_OTHER_TAB';
          session.nextStepAt = null;
          session.updatedAt = Date.now();
          await storage.saveSession(tabId, session);
          await updateBadgeForTab(tabId, session, null, settings);
          await logger.info('AUTO', 'Automatisation mise en pause : utilisateur actif sur un autre onglet', {
            mainTabId: tabId
          });
          return session;
        }

        // auto_switch policy: record return tab and briefly focus mainTab
        const returnMap = await storage.getUserReturnTabs();
        returnMap[String(mainTab.windowId)] = activeTab.id;
        await storage.setUserReturnTabs(returnMap);
        await tabManager.activateTab(tabId);
      }

      session.state = STATES.OPENING_AD;
      session.stepStartedDone = session.done ?? 0;
      session.currentStepIndex = (session.done ?? 0) + 1;
      session.nextStepAt = null;
      session.pauseReason = null;
      session.lastError = null;
      session.stepDeadlineAt = Date.now() + settings.openAdTimeoutMs;
      session.updatedAt = Date.now();

      await storage.saveSession(tabId, session);
      await updateBadgeForTab(tabId, session, null, settings);
      await syncWatchdogState();

      await tabManager.armOpenExpectation(tabId, mainTab.windowId, session.currentStepIndex);

      let clickResp = null;
      try {
        clickResp = await chromeApi.tabs.sendMessage(tabId, {
          type: MSG.TRIGGER_AD_STEP,
          expectedDone: session.stepStartedDone
        });
      } catch (err) {
        clickResp = { ok: false, clicked: false, reason: err?.message || 'MESSAGE_FAILED' };
      }

      if (!clickResp?.clicked) {
        await tabManager.disarmOpenExpectation(tabId);
        if (clickResp?.reason === 'ALREADY_COMPLETED') {
          session.state = STATES.COMPLETED;
          await storage.saveSession(tabId, session);
          await updateBadgeForTab(tabId, session, null, settings);
          await syncWatchdogState();
          return session;
        }
        if (clickResp?.reason === 'SITE_COOLDOWN_ACTIVE' && clickResp.timerSeconds) {
          const waitMs = (clickResp.timerSeconds + 1) * 1000;
          session.state = STATES.NEXT_STEP;
          session.nextStepAt = Date.now() + waitMs;
          await storage.saveSession(tabId, session);
          setTabTimer(tabId, waitMs, () => triggerNextStep(tabId));
          return session;
        }
        if (clickResp?.reason === 'STEP_ALREADY_PROGRESSED' && clickResp.snapshot) {
          session.state = STATES.READY;
          await storage.saveSession(tabId, session);
          setTabTimer(tabId, 50, () => handleContentSnapshot(tabId, clickResp.snapshot));
          return session;
        }

        await handleStepFailureLocked(tabId, session, settings, clickResp?.reason || 'Échec du clic sur Continuer');
        return session;
      }

      await logger.info('AUTO', 'Étape publicitaire déclenchée', {
        mainTabId: tabId,
        step: session.currentStepIndex,
        required: session.required
      });

      setTabTimer(tabId, settings.openAdTimeoutMs, () => handleStepTimeout(tabId));
      return session;
    });
  }

  async function onAdTabCreated(mainTabId, adTabRecord) {
    return withTabLock(mainTabId, async () => {
      const settings = await storage.getSettings();
      const sessions = await storage.getSessions();
      const session = sessions[String(mainTabId)];
      if (!session || !settings.enabled || session.state === STATES.STOPPED) {
        return null;
      }

      const safeHoldMs = Math.max(TIMING_CONSTANTS.MIN_SAFE_AD_HOLD_MS, settings.adHoldMs);
      const now = Date.now();
      session.state = STATES.WAITING_VALIDATION;
      session.adTabId = adTabRecord.adTabId;
      session.adOpenedAt = adTabRecord.openedAt;
      session.adHoldUntil = adTabRecord.openedAt + safeHoldMs;
      session.stepDeadlineAt = now + settings.stepTimeoutMs;
      session.updatedAt = now;

      await storage.saveSession(mainTabId, session);
      await updateBadgeForTab(mainTabId, session, null, settings);
      await syncWatchdogState();

      const remainingMs = Math.max(100, session.adHoldUntil - now);
      setTabTimer(mainTabId, remainingMs, () => completeAdHoldAndReturn(mainTabId));
      return session;
    });
  }

  async function completeAdHoldAndReturn(mainTabId) {
    return withTabLock(mainTabId, async () => {
      const settings = await storage.getSettings();
      if (!settings.enabled) return null;

      const sessions = await storage.getSessions();
      const session = sessions[String(mainTabId)];
      if (!session || session.state !== STATES.WAITING_VALIDATION) {
        return session || null;
      }

      const now = Date.now();
      if (session.adHoldUntil && now < session.adHoldUntil) {
        setTabTimer(mainTabId, session.adHoldUntil - now, () => completeAdHoldAndReturn(mainTabId));
        return session;
      }

      // Wait briefly (max +1.5s) if ad tab is still on about:blank so /go/<token> request finishes
      if (session.adTabId) {
        const managed = await storage.getManagedAdTabs();
        const adRec = managed[String(session.adTabId)];
        if (adRec && adRec.lastUrl === 'about:blank' && now - adRec.openedAt < (settings.adHoldMs + 1500)) {
          setTabTimer(mainTabId, 350, () => completeAdHoldAndReturn(mainTabId));
          return session;
        }
      }

      const mainTab = await tabManager.getTabSafe(mainTabId);
      if (!mainTab) {
        await storage.saveSession(mainTabId, null);
        await syncWatchdogState();
        return null;
      }

      const activeTab = await tabManager.getActiveTabInWindow(mainTab.windowId);
      const adTabIdToClose = session.adTabId;

      session.state = STATES.RETURNING;
      session.adTabId = null;
      session.stepDeadlineAt = Date.now() + settings.stepTimeoutMs;
      session.updatedAt = Date.now();
      await storage.saveSession(mainTabId, session);
      await updateBadgeForTab(mainTabId, session, null, settings);

      if (adTabIdToClose && settings.autoCloseAdTabs) {
        await tabManager.closeManagedAdTab(adTabIdToClose);
      }

      // Check if user switched to a completely unrelated tab in the same window
      const userSwitchedAway =
        activeTab && activeTab.id !== mainTabId && activeTab.id !== adTabIdToClose;

      if (userSwitchedAway && settings.focusPolicy === FOCUS_POLICIES.RESPECTFUL) {
        session.state = STATES.PAUSED_FOCUS;
        session.pauseReason = 'RETURN_NEEDED_FOR_VALIDATION';
        await storage.saveSession(mainTabId, session);
        await updateBadgeForTab(mainTabId, session, null, settings);
        await logger.info('AUTO', 'Attente du retour manuel sur l’onglet Senpai Stream pour valider', {
          mainTabId
        });
        return session;
      }

      if (userSwitchedAway && settings.focusPolicy === FOCUS_POLICIES.AUTO_SWITCH) {
        const returnMap = await storage.getUserReturnTabs();
        returnMap[String(mainTab.windowId)] = activeTab.id;
        await storage.setUserReturnTabs(returnMap);
      }

      await tabManager.activateTab(mainTabId);

      // Request snapshot in case DOM already updated without firing a fresh mutation
      const snapResp = await chromeApi.tabs
        .sendMessage(mainTabId, { type: MSG.REQUEST_DOM_SNAPSHOT })
        .catch(() => null);

      setTabTimer(mainTabId, settings.stepTimeoutMs, () => handleStepTimeout(mainTabId));

      if (snapResp?.snapshot && typeof snapResp.snapshot.done === 'number') {
        const baseline = typeof session.stepStartedDone === 'number' ? session.stepStartedDone : 0;
        if (snapResp.snapshot.done > baseline || snapResp.snapshot.playerReady) {
          Promise.resolve().then(() => handleContentSnapshot(mainTabId, snapResp.snapshot));
        }
      }

      return session;
    });
  }

  async function onAdTabRemoved(mainTabId, adRecord) {
    return withTabLock(mainTabId, async () => {
      const settings = await storage.getSettings();
      const sessions = await storage.getSessions();
      const session = sessions[String(mainTabId)];
      if (!session || session.state !== STATES.WAITING_VALIDATION || session.adTabId !== adRecord.adTabId) {
        return;
      }

      const openDuration = Date.now() - adRecord.openedAt;
      session.adTabId = null;

      if (openDuration < 1550) {
        await logger.warn('TAB', 'Onglet publicitaire fermé prématurément (< 1,5 s)', {
          mainTabId,
          openDuration
        });
        await handleStepFailureLocked(
          mainTabId,
          session,
          settings,
          `Onglet publicitaire fermé trop vite (${openDuration} ms).`
        );
        return;
      }

      // User manually closed the ad tab after holding >= 1.55s; proceed to validation return
      await storage.saveSession(mainTabId, session);
      setTabTimer(mainTabId, 50, () => completeAdHoldAndReturn(mainTabId));
    });
  }

  async function handleStepTimeout(mainTabId) {
    return withTabLock(mainTabId, async () => {
      const settings = await storage.getSettings();
      const sessions = await storage.getSessions();
      const session = sessions[String(mainTabId)];
      if (!session || !ACTIVE_RUN_STATES.has(session.state)) return;

      if (session.stepDeadlineAt && Date.now() < session.stepDeadlineAt - 100) {
        setTabTimer(mainTabId, session.stepDeadlineAt - Date.now(), () => handleStepTimeout(mainTabId));
        return;
      }

      await tabManager.disarmOpenExpectation(mainTabId);
      if (session.adTabId && settings.autoCloseAdTabs) {
        await tabManager.closeManagedAdTab(session.adTabId);
        session.adTabId = null;
      }

      const reason =
        session.state === STATES.OPENING_AD
          ? 'Aucun onglet publicitaire ne s’est ouvert dans le délai imparti (popup bloquée ?).'
          : 'Délai maximal dépassé en attendant la confirmation de validation du site.';

      await handleStepFailureLocked(mainTabId, session, settings, reason);
    });
  }

  async function handleStepFailureLocked(mainTabId, session, settings, reason) {
    clearTabTimer(mainTabId);
    await tabManager.disarmOpenExpectation(mainTabId);

    session.retriesOnCurrentStep += 1;
    session.adTabId = null;
    session.adOpenedAt = null;
    session.adHoldUntil = null;
    session.stepDeadlineAt = null;
    session.updatedAt = Date.now();

    if (session.retriesOnCurrentStep <= settings.maxRetries) {
      session.state = STATES.NEXT_STEP;
      session.lastError = `Nouvelle tentative (${session.retriesOnCurrentStep}/${settings.maxRetries}) : ${reason}`;
      const backoffMs = Math.max(1200, settings.interStepDelayMs);
      session.nextStepAt = Date.now() + backoffMs;
      await storage.saveSession(mainTabId, session);
      await updateBadgeForTab(mainTabId, session, null, settings);
      await logger.warn('AUTO', 'Nouvelle tentative planifiée après échec d’étape', {
        mainTabId,
        retry: session.retriesOnCurrentStep,
        maxRetries: settings.maxRetries,
        reason
      });
      setTabTimer(mainTabId, backoffMs, () => triggerNextStep(mainTabId));
      return;
    }

    session.state = STATES.ERROR;
    session.lastError = `${reason} (nombre maximal de tentatives atteint : ${settings.maxRetries}).`;
    await storage.saveSession(mainTabId, session);
    await updateBadgeForTab(mainTabId, session, null, settings);
    await syncWatchdogState();
    await logger.error('AUTO', 'Automatisation bloquée après épuisement des tentatives', {
      mainTabId,
      reason
    });
    await notifyUser(
      `senpai-error-${mainTabId}`,
      'Senpai Stream — Intervention requise',
      session.lastError
    );
  }

  async function startManual(tabId) {
    return withTabLock(tabId, async () => {
      let settings = await storage.getSettings();
      if (!settings.enabled) {
        settings = await storage.saveSettings({ enabled: true });
      }

      const snapResp = await chromeApi.tabs
        .sendMessage(tabId, { type: MSG.REQUEST_DOM_SNAPSHOT })
        .catch(() => null);

      const sessions = await storage.getSessions();
      let session = sessions[String(tabId)];
      if (!session && snapResp?.snapshot) {
        session = createBlankSession(tabId, snapResp.snapshot);
      }

      if (!session) {
        return { ok: false, error: 'Page Senpai Stream non détectée ou non autorisée sur cet onglet.' };
      }

      if (snapResp?.snapshot) {
        session.pageKind = snapResp.snapshot.pageKind;
        session.domVerified = snapResp.snapshot.domVerified;
        if (typeof snapResp.snapshot.done === 'number') session.done = snapResp.snapshot.done;
        if (typeof snapResp.snapshot.required === 'number') session.required = snapResp.snapshot.required;
      }

      if (session.pageKind === PAGE_KINDS.PLAYER_UNLOCKED) {
        session.state = STATES.COMPLETED;
        await storage.saveSession(tabId, session);
        await updateBadgeForTab(tabId, session, null, settings);
        return { ok: true, session };
      }

      if (session.pageKind !== PAGE_KINDS.AD_GATE) {
        return { ok: false, error: 'Aucune interface de 5 publicités détectée sur cet onglet.' };
      }

      clearTabTimer(tabId);
      session.state = STATES.READY;
      session.retriesOnCurrentStep = 0;
      session.lastError = null;
      session.pauseReason = null;
      session.autoStartAttempted = true;
      session.updatedAt = Date.now();
      await storage.saveSession(tabId, session);

      setTabTimer(tabId, 10, () => triggerNextStep(tabId));
      return { ok: true, session };
    });
  }

  async function stopManual(tabId) {
    return withTabLock(tabId, async () => {
      clearTabTimer(tabId);
      await tabManager.disarmOpenExpectation(tabId);
      const settings = await storage.getSettings();
      const sessions = await storage.getSessions();
      const session = sessions[String(tabId)];
      if (!session) {
        return { ok: true };
      }

      if (session.adTabId && settings.autoCloseAdTabs) {
        await tabManager.closeManagedAdTab(session.adTabId);
      }

      session.state = STATES.STOPPED;
      session.adTabId = null;
      session.adOpenedAt = null;
      session.adHoldUntil = null;
      session.stepDeadlineAt = null;
      session.nextStepAt = null;
      session.pauseReason = null;
      session.updatedAt = Date.now();
      await storage.saveSession(tabId, session);
      await updateBadgeForTab(tabId, session, null, settings);
      await syncWatchdogState();
      await logger.info('AUTO', 'Automatisation arrêtée par l’utilisateur', { mainTabId: tabId });
      return { ok: true, session };
    });
  }

  async function setGlobalEnabled(enabled) {
    const settings = await storage.saveSettings({ enabled: Boolean(enabled) });
    const sessions = await storage.getSessions();

    if (!settings.enabled) {
      for (const tabKey of Object.keys(sessions)) {
        await stopManual(Number(tabKey));
      }
      await logger.info('AUTO', 'Extension désactivée globalement');
    } else {
      await logger.info('AUTO', 'Extension activée globalement');
      for (const tabKey of Object.keys(sessions)) {
        const tabId = Number(tabKey);
        const snapResp = await chromeApi.tabs
          .sendMessage(tabId, { type: MSG.REQUEST_DOM_SNAPSHOT })
          .catch(() => null);
        if (snapResp?.snapshot) {
          const s = sessions[tabKey];
          if (s.state === STATES.STOPPED) {
            s.state = STATES.READY;
            s.autoStartAttempted = false;
            await storage.saveSession(tabId, s);
          }
          await handleContentSnapshot(tabId, snapResp.snapshot);
        } else {
          await updateBadgeForTab(tabId, sessions[tabKey], null, settings);
        }
      }
    }

    return settings;
  }

  async function onTabActivated(tabId) {
    const sessions = await storage.getSessions();
    const session = sessions[String(tabId)];
    if (!session || session.state !== STATES.PAUSED_FOCUS) return;

    const settings = await storage.getSettings();
    if (!settings.enabled) return;

    await withTabLock(tabId, async () => {
      const freshSessions = await storage.getSessions();
      const current = freshSessions[String(tabId)];
      if (!current || current.state !== STATES.PAUSED_FOCUS) return;

      await logger.info('AUTO', 'Reprise automatique après retour du focus sur l’onglet', {
        mainTabId: tabId,
        pauseReason: current.pauseReason
      });

      const snapResp = await chromeApi.tabs
        .sendMessage(tabId, { type: MSG.REQUEST_DOM_SNAPSHOT })
        .catch(() => null);

      if (current.pauseReason === 'RETURN_NEEDED_FOR_VALIDATION') {
        current.state = STATES.RETURNING;
        current.pauseReason = null;
        current.stepDeadlineAt = Date.now() + settings.stepTimeoutMs;
        await storage.saveSession(tabId, current);
        if (snapResp?.snapshot) {
          setTabTimer(tabId, 50, () => handleContentSnapshot(tabId, snapResp.snapshot));
        } else {
          setTabTimer(tabId, settings.stepTimeoutMs, () => handleStepTimeout(tabId));
        }
      } else {
        current.state = STATES.READY;
        current.pauseReason = null;
        await storage.saveSession(tabId, current);
        setTabTimer(tabId, 100, () => triggerNextStep(tabId));
      }
    });
  }

  async function onMainTabClosed(tabId) {
    clearTabTimer(tabId);
    await tabManager.disarmOpenExpectation(tabId);
    const sessions = await storage.getSessions();
    if (sessions[String(tabId)]) {
      await storage.saveSession(tabId, null);
      await syncWatchdogState();
    }
  }

  /**
   * Reconciles persisted session state with live browser tabs after SW wakeup/restart.
   */
  async function reconcileSessions() {
    const settings = await storage.getSettings();
    const sessions = await storage.getSessions();
    const managedAdTabs = await storage.getManagedAdTabs();
    const liveTabs = await chromeApi.tabs.query({});
    const liveIds = new Set(liveTabs.map((t) => t.id));
    const now = Date.now();

    // Clean orphaned managed ad tabs
    let managedChanged = false;
    for (const [adKey, rec] of Object.entries(managedAdTabs)) {
      if (!liveIds.has(rec.adTabId) || !liveIds.has(rec.mainTabId)) {
        delete managedAdTabs[adKey];
        managedChanged = true;
      }
    }
    if (managedChanged) {
      await storage.setManagedAdTabs(managedAdTabs);
    }

    for (const [tabKey, session] of Object.entries(sessions)) {
      const mainTabId = Number(tabKey);
      if (!liveIds.has(mainTabId)) {
        clearTabTimer(mainTabId);
        await storage.saveSession(mainTabId, null);
        continue;
      }

      if (!settings.enabled) {
        if (ACTIVE_RUN_STATES.has(session.state)) {
          session.state = STATES.STOPPED;
          await storage.saveSession(mainTabId, session);
        }
        continue;
      }

      if (session.state === STATES.WAITING_VALIDATION) {
        if (session.adTabId && !liveIds.has(session.adTabId)) {
          await onAdTabRemoved(mainTabId, {
            adTabId: session.adTabId,
            mainTabId,
            openedAt: session.adOpenedAt || now
          });
        } else if (session.adHoldUntil && now >= session.adHoldUntil) {
          await completeAdHoldAndReturn(mainTabId);
        } else if (session.adHoldUntil) {
          setTabTimer(mainTabId, session.adHoldUntil - now, () => completeAdHoldAndReturn(mainTabId));
        }
      } else if (session.state === STATES.OPENING_AD || session.state === STATES.RETURNING) {
        if (session.stepDeadlineAt && now >= session.stepDeadlineAt) {
          await handleStepTimeout(mainTabId);
        } else if (session.stepDeadlineAt) {
          setTabTimer(mainTabId, session.stepDeadlineAt - now, () => handleStepTimeout(mainTabId));
        }
      } else if (session.state === STATES.NEXT_STEP) {
        const delay = session.nextStepAt ? Math.max(0, session.nextStepAt - now) : 100;
        setTabTimer(mainTabId, delay, () => triggerNextStep(mainTabId));
      }
    }

    await syncWatchdogState();
  }

  function formatSessionForUi(session) {
    if (!session) return null;
    return {
      ...session,
      stateLabel: STATE_LABELS_FR[session.state] || session.state
    };
  }

  return {
    handleContentSnapshot,
    triggerNextStep,
    onAdTabCreated,
    completeAdHoldAndReturn,
    onAdTabRemoved,
    handleStepTimeout,
    startManual,
    stopManual,
    setGlobalEnabled,
    onTabActivated,
    onMainTabClosed,
    reconcileSessions,
    updateBadgeForTab,
    formatSessionForUi
  };
}
