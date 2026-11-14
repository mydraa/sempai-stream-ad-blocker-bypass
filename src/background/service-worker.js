import { MSG, TIMING_CONSTANTS } from '../shared/constants.js';
import { normalizeOriginInput } from '../shared/domain-utils.js';
import { createLogger } from '../shared/logger.js';
import { createStorageClient } from '../shared/storage.js';
import { createAutomationManager } from './automation-manager.js';
import { createTabManager } from './tab-manager.js';

const storage = createStorageClient();
const logger = createLogger(storage);
const tabManager = createTabManager({ storage, logger });
const automationManager = createAutomationManager({ storage, tabManager, logger });

let initPromise = null;
function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      await storage.ensureDefaults();
      await tabManager.syncAllDynamicScripts();
      await automationManager.reconcileSessions();
    })().catch(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

async function inspectAndAttachTab(tabId, url) {
  const evaluation = await tabManager.evaluateTabUrl(tabId, url);
  const settings = await storage.getSettings();

  if (evaluation.status === 'AUTHORIZED') {
    const injected = await tabManager.ensureContentScriptInjected(tabId);
    if (injected.snapshot) {
      await automationManager.handleContentSnapshot(tabId, injected.snapshot);
    }
    return evaluation;
  }

  if (evaluation.status === 'CANDIDATE_UNAUTHORIZED') {
    const candidates = await storage.getCandidateTabs();
    await automationManager.updateBadgeForTab(tabId, null, candidates[String(tabId)], settings);
    return evaluation;
  }

  const sessions = await storage.getSessions();
  await automationManager.updateBadgeForTab(tabId, sessions[String(tabId)] || null, null, settings);
  return evaluation;
}

async function getPopupStateForTab(tabId) {
  await ensureInitialized();
  const settings = await storage.getSettings();
  const domains = await storage.getAuthorizedDomains();
  const sessions = await storage.getSessions();
  const candidates = await storage.getCandidateTabs();

  const tab = typeof tabId === 'number' ? await tabManager.getTabSafe(tabId) : null;
  let domainInfo = {
    url: tab?.url || '',
    origin: null,
    originPattern: null,
    hostname: null,
    isAuthorized: false,
    isCandidate: false,
    domainEnabled: true,
    domVerified: false
  };

  if (tab?.url) {
    const evalResult = await tabManager.evaluateTabUrl(tab.id, tab.url);
    domainInfo.origin = evalResult.origin || null;
    domainInfo.originPattern = evalResult.originPattern || null;
    domainInfo.hostname = evalResult.hostname || null;

    if (evalResult.status === 'AUTHORIZED') {
      domainInfo.isAuthorized = true;
      domainInfo.domainEnabled = evalResult.domain.enabled !== false;
      domainInfo.domVerified = Boolean(evalResult.domain.domVerified);
      if (!sessions[String(tab.id)]) {
        const injected = await tabManager.ensureContentScriptInjected(tab.id);
        if (injected.snapshot) {
          await automationManager.handleContentSnapshot(tab.id, injected.snapshot);
        }
      }
    } else if (evalResult.status === 'CANDIDATE_UNAUTHORIZED') {
      domainInfo.isCandidate = true;
    }
  }

  const freshSessions = await storage.getSessions();
  const session = freshSessions[String(tabId)] || null;

  return {
    ok: true,
    settings,
    domains,
    domainInfo,
    candidate: tab ? candidates[String(tab.id)] || null : null,
    session: automationManager.formatSessionForUi(session)
  };
}

// Synchronous top-level event registration required by Manifest V3
chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureInitialized();
  await logger.info('SW', `Extension ${details.reason}`, { version: chrome.runtime.getManifest().version });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInitialized();
  await logger.info('SW', 'Démarrage navigateur / réveil service worker');
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ensureInitialized();
  const result = await tabManager.handleTabCreated(tab);
  if (result?.matched) {
    await automationManager.onAdTabCreated(result.mainTabId, result.record);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureInitialized();
  const updated = await tabManager.handleTabUpdated(tabId, changeInfo, tab);
  if (updated.role === 'AD_TAB') return;

  if (changeInfo.status === 'complete' && tab?.url) {
    await inspectAndAttachTab(tabId, tab.url);
  }
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await ensureInitialized();
  await inspectAndAttachTab(details.tabId, details.url);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureInitialized();
  const removed = await tabManager.handleTabRemoved(tabId);
  if (removed.role === 'AD_TAB') {
    await automationManager.onAdTabRemoved(removed.record.mainTabId, removed.record);
  } else {
    await automationManager.onMainTabClosed(tabId);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await ensureInitialized();
  await automationManager.onTabActivated(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== TIMING_CONSTANTS.WATCHDOG_ALARM_NAME) return;
  await ensureInitialized();
  await automationManager.reconcileSessions();
});

chrome.permissions.onRemoved.addListener(async (permissions) => {
  await ensureInitialized();
  if (!permissions?.origins?.length) return;
  for (const originPattern of permissions.origins) {
    const origin = originPattern.replace(/\/\*$/, '');
    await tabManager.unregisterDynamicOriginScript(origin);
    await storage.removeAuthorizedDomain(origin);
    await logger.info('PERM', 'Autorisation domaine révoquée', { origin });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  (async () => {
    await ensureInitialized();

    switch (message.type) {
      case MSG.CONTENT_READY:
      case MSG.DOM_SNAPSHOT: {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number' || !message.snapshot) {
          sendResponse({ ok: false });
          return;
        }
        const session = await automationManager.handleContentSnapshot(tabId, message.snapshot);
        sendResponse({ ok: true, session: automationManager.formatSessionForUi(session) });
        return;
      }

      case MSG.GET_POPUP_STATE: {
        const state = await getPopupStateForTab(message.tabId);
        sendResponse(state);
        return;
      }

      case MSG.START_AUTOMATION: {
        const res = await automationManager.startManual(message.tabId);
        sendResponse({
          ...res,
          session: automationManager.formatSessionForUi(res.session)
        });
        return;
      }

      case MSG.STOP_AUTOMATION: {
        const res = await automationManager.stopManual(message.tabId);
        sendResponse({
          ...res,
          session: automationManager.formatSessionForUi(res.session)
        });
        return;
      }

      case MSG.SET_ENABLED: {
        const settings = await automationManager.setGlobalEnabled(message.enabled);
        sendResponse({ ok: true, settings });
        return;
      }

      case MSG.DOMAIN_AUTHORIZED: {
        const desc = normalizeOriginInput(message.origin);
        if (!desc) {
          sendResponse({ ok: false, error: 'Origine de domaine invalide.' });
          return;
        }
        const hasPerm = await tabManager.hasOriginPermission(desc.originPattern);
        if (!hasPerm) {
          sendResponse({ ok: false, error: 'Permission Chrome non accordée pour ce domaine.' });
          return;
        }
        await storage.upsertAuthorizedDomain({
          origin: desc.origin,
          originPattern: desc.originPattern,
          hostname: desc.hostname,
          builtIn: false,
          enabled: true,
          domVerified: false,
          addedAt: Date.now(),
          lastVerifiedAt: null
        });
        await tabManager.registerDynamicOriginScript(desc.origin);
        await logger.info('PERM', 'Nouveau domaine ajouté et autorisé', { origin: desc.origin });

        if (typeof message.tabId === 'number') {
          const tab = await tabManager.getTabSafe(message.tabId);
          if (tab?.url) {
            await inspectAndAttachTab(tab.id, tab.url);
          }
        }
        const domains = await storage.getAuthorizedDomains();
        sendResponse({ ok: true, domains });
        return;
      }

      case MSG.DOMAIN_REMOVED: {
        const desc = normalizeOriginInput(message.origin);
        if (!desc) {
          sendResponse({ ok: false, error: 'Domaine invalide.' });
          return;
        }
        await tabManager.unregisterDynamicOriginScript(desc.origin);
        try {
          await chrome.permissions.remove({ origins: [desc.originPattern] });
        } catch {
          // Built-in host_permissions cannot be removed by permissions.remove
        }
        const domains = await storage.removeAuthorizedDomain(desc.origin);
        await logger.info('PERM', 'Domaine supprimé des autorisations', { origin: desc.origin });
        sendResponse({ ok: true, domains });
        return;
      }

      case MSG.TOGGLE_DOMAIN_ENABLED: {
        const domains = await storage.getAuthorizedDomains();
        const target = domains.find((d) => d.origin === message.origin);
        if (!target) {
          sendResponse({ ok: false, error: 'Domaine introuvable.' });
          return;
        }
        const updated = await storage.upsertAuthorizedDomain({
          ...target,
          enabled: Boolean(message.enabled)
        });
        await logger.info('PERM', 'Statut du domaine mis à jour', {
          origin: target.origin,
          enabled: Boolean(message.enabled)
        });
        sendResponse({ ok: true, domains: updated });
        return;
      }

      case MSG.GET_SETTINGS: {
        const settings = await storage.getSettings();
        const domains = await storage.getAuthorizedDomains();
        sendResponse({ ok: true, settings, domains });
        return;
      }

      case MSG.UPDATE_SETTINGS: {
        const settings = await storage.saveSettings(message.settings || {});
        await logger.info('SW', 'Paramètres mis à jour');
        sendResponse({ ok: true, settings });
        return;
      }

      case MSG.GET_LOGS: {
        const logs = await storage.getLogs();
        sendResponse({ ok: true, logs });
        return;
      }

      case MSG.CLEAR_LOGS: {
        await storage.clearLogs();
        sendResponse({ ok: true });
        return;
      }

      case MSG.REVERIFY_TAB: {
        if (typeof message.tabId === 'number') {
          const tab = await tabManager.getTabSafe(message.tabId);
          if (tab?.url) {
            await inspectAndAttachTab(tab.id, tab.url);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Message non pris en charge.' });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: err?.message || 'Erreur interne.' });
  });

  return true;
});
