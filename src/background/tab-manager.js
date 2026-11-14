import { BUILTIN_ORIGIN, CONTENT_SCRIPT_FILES, MSG } from '../shared/constants.js';
import { getScriptIdForOrigin, isCandidateHostname, parseUrlSafe } from '../shared/domain-utils.js';

/**
 * Manages Chrome tabs, permissions checks, dynamic script injection,
 * and strict ownership tracking of extension-opened ad tabs.
 */
export function createTabManager({ storage, logger, chromeApi = globalThis.chrome }) {
  async function armOpenExpectation(mainTabId, windowId, stepIndex) {
    const pending = await storage.getPendingOpens();
    pending[String(mainTabId)] = {
      mainTabId,
      windowId,
      stepIndex,
      armedAt: Date.now()
    };
    await storage.setPendingOpens(pending);
  }

  async function disarmOpenExpectation(mainTabId) {
    const pending = await storage.getPendingOpens();
    if (pending[String(mainTabId)]) {
      delete pending[String(mainTabId)];
      await storage.setPendingOpens(pending);
    }
  }

  async function handleTabCreated(tab) {
    if (!tab || typeof tab.id !== 'number') return null;

    const pending = await storage.getPendingOpens();
    const now = Date.now();
    let matchedMainTabId = null;

    // Primary correlation: Chrome sets openerTabId to mainTabId synchronously on window.open
    for (const [key, entry] of Object.entries(pending)) {
      if (now - entry.armedAt > 10000) continue;
      if (tab.openerTabId === entry.mainTabId) {
        matchedMainTabId = entry.mainTabId;
        break;
      }
    }

    // Secondary correlation: same window within 2.5s of click when openerTabId is cleared
    if (matchedMainTabId === null) {
      for (const entry of Object.values(pending)) {
        if (now - entry.armedAt <= 2500 && tab.windowId === entry.windowId) {
          matchedMainTabId = entry.mainTabId;
          break;
        }
      }
    }

    if (matchedMainTabId === null) {
      return null;
    }

    const expected = pending[String(matchedMainTabId)];
    delete pending[String(matchedMainTabId)];
    await storage.setPendingOpens(pending);

    const managed = await storage.getManagedAdTabs();
    const initialUrl = tab.pendingUrl || tab.url || 'about:blank';
    const record = {
      adTabId: tab.id,
      mainTabId: matchedMainTabId,
      stepIndex: expected.stepIndex,
      windowId: tab.windowId,
      openedAt: now,
      initialUrl,
      lastUrl: initialUrl,
      loaded: tab.status === 'complete' && initialUrl !== 'about:blank'
    };
    managed[String(tab.id)] = record;
    await storage.setManagedAdTabs(managed);

    await logger.info('TAB', 'Onglet publicitaire géré détecté', {
      adTabId: tab.id,
      mainTabId: matchedMainTabId,
      stepIndex: expected.stepIndex
    });

    return { matched: true, mainTabId: matchedMainTabId, record };
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    const managed = await storage.getManagedAdTabs();
    const adRecord = managed[String(tabId)];
    if (adRecord) {
      const nextUrl = changeInfo.url || tab?.url || adRecord.lastUrl;
      const leftBlank = nextUrl && nextUrl !== 'about:blank';
      adRecord.lastUrl = nextUrl || adRecord.lastUrl;
      if (leftBlank && (changeInfo.status === 'complete' || tab?.status === 'complete')) {
        adRecord.loaded = true;
      }
      managed[String(tabId)] = adRecord;
      await storage.setManagedAdTabs(managed);
      return { role: 'AD_TAB', record: adRecord };
    }
    return { role: 'OTHER', url: tab?.url || changeInfo.url || null };
  }

  async function handleTabRemoved(tabId) {
    const managed = await storage.getManagedAdTabs();
    const adRecord = managed[String(tabId)];
    if (adRecord) {
      delete managed[String(tabId)];
      await storage.setManagedAdTabs(managed);
      return { role: 'AD_TAB', record: adRecord };
    }

    const pending = await storage.getPendingOpens();
    if (pending[String(tabId)]) {
      delete pending[String(tabId)];
      await storage.setPendingOpens(pending);
    }

    const candidates = await storage.getCandidateTabs();
    if (candidates[String(tabId)]) {
      delete candidates[String(tabId)];
      await storage.setCandidateTabs(candidates);
    }

    return { role: 'OTHER' };
  }

  async function closeManagedAdTab(adTabId) {
    if (typeof adTabId !== 'number') return { closed: false, reason: 'INVALID_ID' };

    const managed = await storage.getManagedAdTabs();
    const record = managed[String(adTabId)];
    if (!record) {
      await logger.warn('TAB', 'Refus de fermer un onglet non géré par l’extension', { adTabId });
      return { closed: false, reason: 'NOT_MANAGED' };
    }

    delete managed[String(adTabId)];
    await storage.setManagedAdTabs(managed);

    try {
      await chromeApi.tabs.remove(adTabId);
      await logger.info('TAB', 'Onglet publicitaire géré fermé', { adTabId, mainTabId: record.mainTabId });
      return { closed: true };
    } catch (err) {
      return { closed: false, reason: 'ALREADY_CLOSED', error: err?.message };
    }
  }

  async function activateTab(tabId) {
    if (typeof tabId !== 'number') return false;
    try {
      await chromeApi.tabs.update(tabId, { active: true });
      return true;
    } catch {
      return false;
    }
  }

  async function getTabSafe(tabId) {
    try {
      return await chromeApi.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function getActiveTabInWindow(windowId) {
    try {
      const tabs = await chromeApi.tabs.query({ windowId, active: true });
      return tabs[0] || null;
    } catch {
      return null;
    }
  }

  async function hasOriginPermission(originPattern) {
    try {
      return await chromeApi.permissions.contains({ origins: [originPattern] });
    } catch {
      return false;
    }
  }

  async function registerDynamicOriginScript(origin) {
    if (!origin || origin === BUILTIN_ORIGIN || !chromeApi.scripting?.registerContentScripts) {
      return;
    }
    const id = getScriptIdForOrigin(origin);
    const originPattern = `${origin}/*`;
    try {
      const existing = await chromeApi.scripting.getRegisteredContentScripts({ ids: [id] });
      if (existing && existing.length > 0) {
        return;
      }
      await chromeApi.scripting.registerContentScripts([
        {
          id,
          matches: [originPattern],
          js: [...CONTENT_SCRIPT_FILES],
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true
        }
      ]);
      await logger.info('PERM', 'Script dynamique enregistré pour le domaine', { origin });
    } catch (err) {
      await logger.warn('PERM', 'Échec enregistrement script dynamique', { origin, error: err?.message });
    }
  }

  async function unregisterDynamicOriginScript(origin) {
    if (!origin || origin === BUILTIN_ORIGIN || !chromeApi.scripting?.unregisterContentScripts) {
      return;
    }
    const id = getScriptIdForOrigin(origin);
    try {
      const existing = await chromeApi.scripting.getRegisteredContentScripts({ ids: [id] });
      if (existing && existing.length > 0) {
        await chromeApi.scripting.unregisterContentScripts({ ids: [id] });
      }
    } catch {
      // Ignore if already unregistered
    }
  }

  async function syncAllDynamicScripts() {
    const domains = await storage.getAuthorizedDomains();
    for (const domain of domains) {
      if (domain.builtIn) continue;
      const granted = await hasOriginPermission(domain.originPattern);
      if (granted) {
        await registerDynamicOriginScript(domain.origin);
      }
    }
  }

  async function ensureContentScriptInjected(tabId) {
    try {
      const ping = await chromeApi.tabs.sendMessage(tabId, { type: MSG.PING });
      if (ping?.ok) {
        return { injected: true, alreadyPresent: true, snapshot: ping.snapshot };
      }
    } catch {
      // Not injected yet
    }

    try {
      await chromeApi.scripting.executeScript({
        target: { tabId },
        files: [...CONTENT_SCRIPT_FILES]
      });
      const afterPing = await chromeApi.tabs.sendMessage(tabId, { type: MSG.PING }).catch(() => null);
      return { injected: true, alreadyPresent: false, snapshot: afterPing?.snapshot || null };
    } catch (err) {
      await logger.warn('TAB', 'Injection du content script impossible', { tabId, error: err?.message });
      return { injected: false, error: err?.message };
    }
  }

  async function evaluateTabUrl(tabId, rawUrl) {
    const parsed = parseUrlSafe(rawUrl);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      const candidates = await storage.getCandidateTabs();
      if (candidates[String(tabId)]) {
        delete candidates[String(tabId)];
        await storage.setCandidateTabs(candidates);
      }
      return { status: 'UNSUPPORTED_URL' };
    }

    const origin = parsed.origin;
    const originPattern = `${origin}/*`;
    const hostname = parsed.hostname.toLowerCase();
    const isCandidate = isCandidateHostname(hostname);

    const domains = await storage.getAuthorizedDomains();
    const savedDomain = domains.find((d) => d.origin === origin);
    const hasPerm = await hasOriginPermission(originPattern);

    if (savedDomain && hasPerm) {
      const candidates = await storage.getCandidateTabs();
      if (candidates[String(tabId)]) {
        delete candidates[String(tabId)];
        await storage.setCandidateTabs(candidates);
      }
      return { status: 'AUTHORIZED', domain: savedDomain, origin, originPattern, hostname };
    }

    if (isCandidate) {
      const candidates = await storage.getCandidateTabs();
      candidates[String(tabId)] = {
        origin,
        originPattern,
        hostname,
        detectedAt: Date.now()
      };
      await storage.setCandidateTabs(candidates);
      return { status: 'CANDIDATE_UNAUTHORIZED', origin, originPattern, hostname };
    }

    return { status: 'UNRECOGNIZED', origin, originPattern, hostname };
  }

  return {
    armOpenExpectation,
    disarmOpenExpectation,
    handleTabCreated,
    handleTabUpdated,
    handleTabRemoved,
    closeManagedAdTab,
    activateTab,
    getTabSafe,
    getActiveTabInWindow,
    hasOriginPermission,
    registerDynamicOriginScript,
    unregisterDynamicOriginScript,
    syncAllDynamicScripts,
    ensureContentScriptInjected,
    evaluateTabUrl
  };
}
