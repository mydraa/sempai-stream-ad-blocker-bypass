import { BUILTIN_ORIGIN, DEFAULT_SETTINGS, TIMING_CONSTANTS } from './constants.js';
import { normalizeOriginInput } from './domain-utils.js';

const LOCAL_KEYS = Object.freeze({
  SETTINGS: 'settings',
  AUTHORIZED_DOMAINS: 'authorizedDomains',
  LOGS: 'logs'
});

const SESSION_KEYS = Object.freeze({
  SESSIONS: 'sessions',
  MANAGED_AD_TABS: 'managedAdTabs',
  PENDING_OPENS: 'pendingOpens',
  CANDIDATE_TABS: 'candidateTabs',
  USER_RETURN_TABS: 'userReturnTabs'
});

function getStorageApi(override) {
  if (override) return override;
  if (!globalThis.chrome?.storage) {
    throw new Error('chrome.storage API indisponible.');
  }
  return globalThis.chrome.storage;
}

export function createBuiltinDomainEntry() {
  const desc = normalizeOriginInput(BUILTIN_ORIGIN);
  return {
    origin: desc.origin,
    originPattern: desc.originPattern,
    hostname: desc.hostname,
    builtIn: true,
    enabled: true,
    domVerified: false,
    addedAt: 0,
    lastVerifiedAt: null
  };
}

export function sanitizeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  merged.enabled = Boolean(merged.enabled);
  merged.autoStart = Boolean(merged.autoStart);
  merged.autoCloseAdTabs = Boolean(merged.autoCloseAdTabs);
  merged.notifyOnComplete = Boolean(merged.notifyOnComplete);
  merged.showLogsInSettings = Boolean(merged.showLogsInSettings);
  merged.focusPolicy = merged.focusPolicy === 'auto_switch' ? 'auto_switch' : 'respectful';
  merged.adHoldMs = clampInt(merged.adHoldMs, 1000, 15000, DEFAULT_SETTINGS.adHoldMs);
  merged.stepTimeoutMs = clampInt(merged.stepTimeoutMs, 5000, 120000, DEFAULT_SETTINGS.stepTimeoutMs);
  merged.openAdTimeoutMs = clampInt(merged.openAdTimeoutMs, 2000, 20000, DEFAULT_SETTINGS.openAdTimeoutMs);
  merged.interStepDelayMs = clampInt(merged.interStepDelayMs, 300, 10000, DEFAULT_SETTINGS.interStepDelayMs);
  merged.maxRetries = clampInt(merged.maxRetries, 0, 5, DEFAULT_SETTINGS.maxRetries);
  return merged;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

export function createStorageClient(storageOverride = null) {
  const storage = getStorageApi(storageOverride);

  async function ensureDefaults() {
    const current = await storage.local.get([LOCAL_KEYS.SETTINGS, LOCAL_KEYS.AUTHORIZED_DOMAINS]);
    const updates = {};

    if (!current[LOCAL_KEYS.SETTINGS]) {
      updates[LOCAL_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS };
    }

    const existingDomains = Array.isArray(current[LOCAL_KEYS.AUTHORIZED_DOMAINS])
      ? current[LOCAL_KEYS.AUTHORIZED_DOMAINS]
      : [];
    const hasBuiltin = existingDomains.some((d) => d.origin === BUILTIN_ORIGIN);
    if (!hasBuiltin) {
      updates[LOCAL_KEYS.AUTHORIZED_DOMAINS] = [createBuiltinDomainEntry(), ...existingDomains];
    }

    if (Object.keys(updates).length > 0) {
      await storage.local.set(updates);
    }
  }

  async function getSettings() {
    const data = await storage.local.get(LOCAL_KEYS.SETTINGS);
    return sanitizeSettings(data[LOCAL_KEYS.SETTINGS]);
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = sanitizeSettings({ ...current, ...partial });
    await storage.local.set({ [LOCAL_KEYS.SETTINGS]: next });
    return next;
  }

  async function getAuthorizedDomains() {
    const data = await storage.local.get(LOCAL_KEYS.AUTHORIZED_DOMAINS);
    const list = Array.isArray(data[LOCAL_KEYS.AUTHORIZED_DOMAINS])
      ? data[LOCAL_KEYS.AUTHORIZED_DOMAINS]
      : [createBuiltinDomainEntry()];
    if (!list.some((d) => d.origin === BUILTIN_ORIGIN)) {
      return [createBuiltinDomainEntry(), ...list];
    }
    return list;
  }

  async function upsertAuthorizedDomain(entry) {
    const list = await getAuthorizedDomains();
    const idx = list.findIndex((d) => d.origin === entry.origin);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry, origin: list[idx].origin };
    } else {
      list.push(entry);
    }
    await storage.local.set({ [LOCAL_KEYS.AUTHORIZED_DOMAINS]: list });
    return list;
  }

  async function removeAuthorizedDomain(origin) {
    const list = await getAuthorizedDomains();
    const filtered = list.filter((d) => d.origin !== origin || d.builtIn);
    await storage.local.set({ [LOCAL_KEYS.AUTHORIZED_DOMAINS]: filtered });
    return filtered;
  }

  async function getLogs() {
    const data = await storage.local.get(LOCAL_KEYS.LOGS);
    return Array.isArray(data[LOCAL_KEYS.LOGS]) ? data[LOCAL_KEYS.LOGS] : [];
  }

  async function appendLogEntry(entry) {
    const logs = await getLogs();
    logs.push(entry);
    const trimmed = logs.length > TIMING_CONSTANTS.MAX_LOGS
      ? logs.slice(logs.length - TIMING_CONSTANTS.MAX_LOGS)
      : logs;
    await storage.local.set({ [LOCAL_KEYS.LOGS]: trimmed });
    return trimmed;
  }

  async function clearLogs() {
    await storage.local.set({ [LOCAL_KEYS.LOGS]: [] });
  }

  async function getSessionMap(key) {
    const data = await storage.session.get(key);
    const value = data[key];
    return value && typeof value === 'object' ? value : {};
  }

  async function setSessionMap(key, value) {
    await storage.session.set({ [key]: value });
  }

  async function getSessions() {
    return getSessionMap(SESSION_KEYS.SESSIONS);
  }

  async function saveSession(tabId, session) {
    const sessions = await getSessions();
    if (session === null) {
      delete sessions[String(tabId)];
    } else {
      sessions[String(tabId)] = session;
    }
    await setSessionMap(SESSION_KEYS.SESSIONS, sessions);
    return sessions;
  }

  async function getManagedAdTabs() {
    return getSessionMap(SESSION_KEYS.MANAGED_AD_TABS);
  }

  async function setManagedAdTabs(map) {
    await setSessionMap(SESSION_KEYS.MANAGED_AD_TABS, map);
  }

  async function getPendingOpens() {
    return getSessionMap(SESSION_KEYS.PENDING_OPENS);
  }

  async function setPendingOpens(map) {
    await setSessionMap(SESSION_KEYS.PENDING_OPENS, map);
  }

  async function getCandidateTabs() {
    return getSessionMap(SESSION_KEYS.CANDIDATE_TABS);
  }

  async function setCandidateTabs(map) {
    await setSessionMap(SESSION_KEYS.CANDIDATE_TABS, map);
  }

  async function getUserReturnTabs() {
    return getSessionMap(SESSION_KEYS.USER_RETURN_TABS);
  }

  async function setUserReturnTabs(map) {
    await setSessionMap(SESSION_KEYS.USER_RETURN_TABS, map);
  }

  return {
    LOCAL_KEYS,
    SESSION_KEYS,
    ensureDefaults,
    getSettings,
    saveSettings,
    getAuthorizedDomains,
    upsertAuthorizedDomain,
    removeAuthorizedDomain,
    getLogs,
    appendLogEntry,
    clearLogs,
    getSessions,
    saveSession,
    getManagedAdTabs,
    setManagedAdTabs,
    getPendingOpens,
    setPendingOpens,
    getCandidateTabs,
    setCandidateTabs,
    getUserReturnTabs,
    setUserReturnTabs
  };
}
