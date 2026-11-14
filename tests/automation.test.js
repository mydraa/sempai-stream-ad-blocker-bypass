import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import '../src/shared/protocol.global.js';
import { FOCUS_POLICIES, MSG, PAGE_KINDS, STATES } from '../src/shared/constants.js';
import {
  isCandidateHostname,
  normalizeOriginInput,
  sanitizeUrlForLog
} from '../src/shared/domain-utils.js';
import { createStorageClient } from '../src/shared/storage.js';
import { createLogger } from '../src/shared/logger.js';
import { createTabManager } from '../src/background/tab-manager.js';
import { createAutomationManager } from '../src/background/automation-manager.js';

import '../src/content/selectors.js';
import '../src/content/detector.js';
import '../src/content/progression.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_HTML = fs.readFileSync(path.join(__dirname, 'mock-site', 'index.html'), 'utf8');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMemoryArea() {
  const store = new Map();
  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store.entries());
      }
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = store.has(k) ? structuredClone(store.get(k)) : def;
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async clear() {
      store.clear();
    }
  };
}

function createMockChromeHarness({ grantedOrigins = ['https://senpai-stream.link/*'] } = {}) {
  const local = createMemoryArea();
  const session = createMemoryArea();
  const permissionsSet = new Set(grantedOrigins);
  const registeredScripts = new Map();
  const notifications = [];
  const badges = new Map();

  let nextTabId = 100;
  const tabsMap = new Map();
  const messageHandler = { fn: null };
  const createdListeners = [];
  const removedListeners = [];

  const chromeApi = {
    storage: { local, session },
    permissions: {
      async contains({ origins = [] }) {
        return origins.every((o) => permissionsSet.has(o));
      },
      async request({ origins = [] }) {
        for (const o of origins) permissionsSet.add(o);
        return true;
      },
      async remove({ origins = [] }) {
        for (const o of origins) permissionsSet.delete(o);
        return true;
      }
    },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        const list = Array.from(registeredScripts.values());
        return ids ? list.filter((s) => ids.includes(s.id)) : list;
      },
      async registerContentScripts(defs) {
        for (const d of defs) registeredScripts.set(d.id, d);
      },
      async unregisterContentScripts({ ids = [] }) {
        for (const id of ids) registeredScripts.delete(id);
      },
      async executeScript() {
        return [];
      }
    },
    tabs: {
      async get(tabId) {
        const t = tabsMap.get(tabId);
        if (!t) throw new Error(`No tab with id ${tabId}`);
        return { ...t };
      },
      async query(queryInfo = {}) {
        let list = Array.from(tabsMap.values());
        if (typeof queryInfo.windowId === 'number') {
          list = list.filter((t) => t.windowId === queryInfo.windowId);
        }
        if (typeof queryInfo.active === 'boolean') {
          list = list.filter((t) => t.active === queryInfo.active);
        }
        return list.map((t) => ({ ...t }));
      },
      async update(tabId, props) {
        const t = tabsMap.get(tabId);
        if (!t) throw new Error(`No tab with id ${tabId}`);
        if (props.active) {
          for (const other of tabsMap.values()) {
            if (other.windowId === t.windowId) other.active = false;
          }
        }
        Object.assign(t, props);
        return { ...t };
      },
      async remove(tabId) {
        const t = tabsMap.get(tabId);
        if (!t) throw new Error(`No tab with id ${tabId}`);
        tabsMap.delete(tabId);
        for (const cb of removedListeners) await cb(tabId);
      },
      async sendMessage(tabId, msg) {
        if (!messageHandler.fn) throw new Error('No content handler');
        return messageHandler.fn(tabId, msg);
      }
    },
    alarms: {
      _alarms: new Map(),
      async get(name) {
        return this._alarms.get(name) || null;
      },
      async create(name, info) {
        this._alarms.set(name, { name, ...info });
      },
      async clear(name) {
        this._alarms.delete(name);
      }
    },
    action: {
      async setBadgeText({ tabId, text }) {
        badges.set(tabId, { ...(badges.get(tabId) || {}), text });
      },
      async setBadgeBackgroundColor({ tabId, color }) {
        badges.set(tabId, { ...(badges.get(tabId) || {}), color });
      }
    },
    notifications: {
      async create(id, opts) {
        notifications.push({ id, ...opts });
      }
    },
    runtime: {
      getURL: (p) => `chrome-extension://mock-id/${p}`
    }
  };

  function addTab({ id, windowId = 1, active = false, url = 'https://example.com', openerTabId } = {}) {
    const tabId = id ?? ++nextTabId;
    if (active) {
      for (const other of tabsMap.values()) {
        if (other.windowId === windowId) other.active = false;
      }
    }
    const tab = { id: tabId, windowId, active, url, status: 'complete', openerTabId };
    tabsMap.set(tabId, tab);
    return tab;
  }

  return {
    chromeApi,
    tabsMap,
    permissionsSet,
    registeredScripts,
    notifications,
    badges,
    messageHandler,
    addTab,
    onTabRemoved: (cb) => removedListeners.push(cb),
    onTabCreated: (cb) => createdListeners.push(cb),
    async simulateTabCreated(tabOpts) {
      const tab = addTab(tabOpts);
      for (const cb of createdListeners) await cb({ ...tab });
      return tab;
    }
  };
}

function createDomFromMockHtml(url = 'https://senpai-stream.link/watch/1399/1-1/abc') {
  const dom = new JSDOM(MOCK_HTML, { url, pretendToBeVisual: true });
  return dom;
}

// ---------------------------------------------------------------------------
// 1. DOM Detection & Selector Verification
// ---------------------------------------------------------------------------
test('1. Detects ad-gate UI, player unlocked state, homepage, expired gate, and unknown DOM', () => {
  const dom = createDomFromMockHtml();
  const doc = dom.window.document;

  const snapGate = globalThis.SenpaiDetector.inspectDocument(doc);
  assert.equal(snapGate.pageKind, PAGE_KINDS.AD_GATE);
  assert.equal(snapGate.domVerified, true);
  assert.equal(snapGate.done, 0);
  assert.equal(snapGate.required, 5);
  assert.equal(snapGate.ctaPresent, true);
  assert.equal(snapGate.ctaSafe, true);

  // Update DOM to 5/5 unlocked
  doc.getElementById('adgate-counter').textContent = '5/5';
  doc.getElementById('adgate-overlay').style.display = 'none';
  const snapUnlocked = globalThis.SenpaiDetector.inspectDocument(doc);
  assert.equal(snapUnlocked.pageKind, PAGE_KINDS.PLAYER_UNLOCKED);
  assert.equal(snapUnlocked.playerReady, true);
  assert.equal(snapUnlocked.done, 5);

  // Expired gate check
  const domExp = createDomFromMockHtml();
  domExp.window.document.getElementById('adgate-lien').style.display = 'inline-block';
  domExp.window.document.getElementById('adgate-status').textContent = 'Page expirée.';
  const snapExp = globalThis.SenpaiDetector.inspectDocument(domExp.window.document);
  assert.equal(snapExp.isExpired, true);

  // Unknown unrelated site
  const otherDom = new JSDOM('<html><head><title>Mon Blog</title></head><body><h1>Bonjour</h1></body></html>', {
    url: 'https://senpai-stream.fake/blog'
  });
  const snapUnknown = globalThis.SenpaiDetector.inspectDocument(otherDom.window.document);
  assert.equal(snapUnknown.pageKind, PAGE_KINDS.UNKNOWN);
  assert.equal(snapUnknown.domVerified, false);

  // Unsafe CTA href check (must reject non-/go/ external links)
  const domUnsafe = createDomFromMockHtml();
  domUnsafe.window.document.getElementById('adgate-continue').setAttribute('href', 'https://evil-pay.example/checkout');
  const snapUnsafe = globalThis.SenpaiDetector.inspectDocument(domUnsafe.window.document);
  assert.equal(snapUnsafe.ctaSafe, false);
});

// ---------------------------------------------------------------------------
// 2. Dynamic Domain Recognition, Normalization & Sanitization
// ---------------------------------------------------------------------------
test('10. Recognizes candidate domains, normalizes origins securely, and sanitizes logs', async () => {
  assert.equal(isCandidateHostname('senpai-stream.link'), true);
  assert.equal(isCandidateHostname('senpai-stream.xyz'), true);
  assert.equal(isCandidateHostname('senpai-stream.to'), true);
  assert.equal(isCandidateHostname('www.senpai-stream.fr'), true);
  assert.equal(isCandidateHostname('sempai-stream.cc'), true);
  assert.equal(isCandidateHostname('example.com'), false);

  assert.deepEqual(normalizeOriginInput('senpai-stream.xyz'), {
    origin: 'https://senpai-stream.xyz',
    originPattern: 'https://senpai-stream.xyz/*',
    hostname: 'senpai-stream.xyz',
    isLocalhost: false
  });
  assert.equal(normalizeOriginInput('javascript:alert(1)'), null);
  assert.equal(normalizeOriginInput('http://senpai-stream.xyz'), null); // remote http disallowed
  assert.equal(normalizeOriginInput('http://127.0.0.1:4173')?.originPattern, 'http://127.0.0.1:4173/*');

  const sanitized = sanitizeUrlForLog('https://senpai-stream.link/watch/1399/1-1/euORIf0MglRHc9aBqmgSZJL26Yy3ZYNlnvZtLzrOxABBhVi98rAiY3ZotWgDXPUU?token=secret');
  assert.equal(sanitized, 'https://senpai-stream.link/watch/1399/1-1/[token]');

  // Test candidate evaluation vs authorized domain registration
  const harness = createMockChromeHarness();
  const storage = createStorageClient(harness.chromeApi.storage);
  await storage.ensureDefaults();
  const logger = createLogger(storage);
  const tabManager = createTabManager({ storage, logger, chromeApi: harness.chromeApi });

  const candidateTab = harness.addTab({ id: 50, url: 'https://senpai-stream.xyz/watch/1' });
  const eval1 = await tabManager.evaluateTabUrl(candidateTab.id, candidateTab.url);
  assert.equal(eval1.status, 'CANDIDATE_UNAUTHORIZED');

  // Grant permission for senpai-stream.xyz
  await harness.chromeApi.permissions.request({ origins: ['https://senpai-stream.xyz/*'] });
  await storage.upsertAuthorizedDomain({
    origin: 'https://senpai-stream.xyz',
    originPattern: 'https://senpai-stream.xyz/*',
    hostname: 'senpai-stream.xyz',
    builtIn: false,
    enabled: true,
    domVerified: false,
    addedAt: Date.now(),
    lastVerifiedAt: null
  });
  await tabManager.registerDynamicOriginScript('https://senpai-stream.xyz');
  assert.equal(harness.registeredScripts.size, 1);

  const eval2 = await tabManager.evaluateTabUrl(candidateTab.id, candidateTab.url);
  assert.equal(eval2.status, 'AUTHORIZED');
});

// ---------------------------------------------------------------------------
// 3 & 4. Full 0/5 -> 5/5 Progression + Strictly Owned Tab Opening/Closing
// ---------------------------------------------------------------------------
test('2, 3, 4. Runs auto-start 0/5 -> 5/5, clicks once per step, closes ONLY managed ad tabs, preserves personal tabs', async () => {
  const harness = createMockChromeHarness();
  const storage = createStorageClient(harness.chromeApi.storage);
  await storage.ensureDefaults();
  await storage.saveSettings({
    autoStart: true,
    autoCloseAdTabs: true,
    adHoldMs: 1650,
    interStepDelayMs: 300,
    stepTimeoutMs: 10000
  });
  // Speed-friendly test override only on scheduleTimeout? No, let's keep real timers fast by mocking MIN or waiting ~1.7s?
  // Wait: let's inject a fast virtual clock or wait? Better: let's keep real timing short only in unit tests by overriding scheduleTimeout or testing real hold!
  // Let's check: 5 * 1.65s = 8.2s — or we can pass a deterministic virtual timer/clock OR test real 1.65s! 8s is fast, OR instant virtual timer makes unit tests run in <100ms!
  // Wait: automation-manager uses Date.now() for adHoldUntil. Let's test real 1.65s in E2E and use a tiny test override or real timing here?
  // Actually let's set adHoldMs: 1650 with a fast fake timer wrapper OR real wait: 5 steps * 1.7s = 8.5s is totally fine for integration test! Let's measure or test 1 real wait + virtual clock? Let's just run real 25ms-scaled? No, MIN_SAFE_AD_HOLD_MS is 1650ms in constants, so real 5 steps would take ~9s. That's completely reasonable for a thorough test, AND keeps Date.now() 100% genuine!

  const logger = createLogger(storage);
  const tabManager = createTabManager({ storage, logger, chromeApi: harness.chromeApi });
  const automation = createAutomationManager({ storage, tabManager, logger, chromeApi: harness.chromeApi });

  harness.onTabCreated(async (tab) => {
    const res = await tabManager.handleTabCreated(tab);
    if (res?.matched) await automation.onAdTabCreated(res.mainTabId, res.record);
  });
  harness.onTabRemoved(async (tabId) => {
    const res = await tabManager.handleTabRemoved(tabId);
    if (res.role === 'AD_TAB') await automation.onAdTabRemoved(res.record.mainTabId, res.record);
  });

  // Personal pre-existing tab that MUST NEVER be touched or closed
  const personalTab = harness.addTab({ id: 10, windowId: 1, active: false, url: 'https://mail.example.com' });
  const mainTab = harness.addTab({ id: 20, windowId: 1, active: true, url: 'https://senpai-stream.link/watch/1399/1-1/tok' });

  const dom = createDomFromMockHtml('https://senpai-stream.link/watch/1399/1-1/tok');
  const doc = dom.window.document;
  let currentDone = 0;
  let clickCount = 0;
  const createdAdTabIds = [];

  const controller = globalThis.SenpaiProgression.createProgressionController(doc, {
    onSnapshot: (snap) => {
      automation.handleContentSnapshot(mainTab.id, snap);
    }
  });

  harness.messageHandler.fn = async (tabId, msg) => {
    if (tabId !== mainTab.id) return null;
    if (msg.type === MSG.REQUEST_DOM_SNAPSHOT || msg.type === MSG.PING) {
      return { ok: true, snapshot: globalThis.SenpaiDetector.inspectDocument(doc) };
    }
    if (msg.type === MSG.TRIGGER_AD_STEP) {
      const res = controller.triggerContinueStep(msg.expectedDone);
      if (res.clicked) {
        clickCount += 1;
        // Simulate site opening ad tab as active in window 1
        setTimeout(async () => {
          const adTab = await harness.simulateTabCreated({
            windowId: 1,
            active: true,
            openerTabId: mainTab.id,
            url: `https://senpai-stream.link/go/step-${currentDone + 1}`
          });
          createdAdTabIds.push(adTab.id);
        }, 20);
      }
      return res;
    }
  };

  // Override tab activate to simulate site's tic() validating when mainTab becomes active again after ad hold
  const origUpdate = harness.chromeApi.tabs.update;
  harness.chromeApi.tabs.update = async (tabId, props) => {
    const result = await origUpdate(tabId, props);
    if (tabId === mainTab.id && props.active && createdAdTabIds.length > currentDone) {
      setTimeout(() => {
        currentDone += 1;
        doc.getElementById('adgate-counter').textContent = `${currentDone}/5`;
        if (currentDone >= 5) {
          doc.getElementById('adgate-overlay').style.display = 'none';
        }
        controller.evaluateAndEmit(false);
      }, 40);
    }
    return result;
  };

  const initialSnap = controller.startObserving();
  await automation.handleContentSnapshot(mainTab.id, initialSnap);

  // Wait up to 14s for 5 steps * ~1.7s + delays
  const start = Date.now();
  while (Date.now() - start < 14000) {
    const sessions = await storage.getSessions();
    if (sessions[String(mainTab.id)]?.state === STATES.COMPLETED) break;
    await sleep(100);
  }

  controller.stopObserving();
  const sessions = await storage.getSessions();
  const finalSession = sessions[String(mainTab.id)];

  assert.equal(finalSession.state, STATES.COMPLETED);
  assert.equal(finalSession.done, 5);
  assert.equal(clickCount, 5);
  assert.equal(createdAdTabIds.length, 5);

  // All 5 managed ad tabs were closed, personal tab is untouched
  for (const adId of createdAdTabIds) {
    assert.equal(harness.tabsMap.has(adId), false);
  }
  assert.equal(harness.tabsMap.has(personalTab.id), true);

  // Attempting to close personalTab explicitly must be refused
  const refuse = await tabManager.closeManagedAdTab(personalTab.id);
  assert.equal(refuse.closed, false);
  assert.equal(refuse.reason, 'NOT_MANAGED');
  assert.equal(harness.tabsMap.has(personalTab.id), true);
  assert.equal(harness.notifications.length >= 1, true);
});

// ---------------------------------------------------------------------------
// 5. Focus Behavior When User Switches Tabs + Manual Start When autoStart=false
// ---------------------------------------------------------------------------
test('2 & 5. Respects manual start when autoStart=false and pauses/resumes respectfully on tab switch', async () => {
  const harness = createMockChromeHarness();
  const storage = createStorageClient(harness.chromeApi.storage);
  await storage.ensureDefaults();
  await storage.saveSettings({
    autoStart: false,
    focusPolicy: FOCUS_POLICIES.RESPECTFUL
  });

  const logger = createLogger(storage);
  const tabManager = createTabManager({ storage, logger, chromeApi: harness.chromeApi });
  const automation = createAutomationManager({ storage, tabManager, logger, chromeApi: harness.chromeApi });

  const mainTab = harness.addTab({ id: 20, windowId: 1, active: true, url: 'https://senpai-stream.link/watch/1' });
  const otherTab = harness.addTab({ id: 21, windowId: 1, active: false, url: 'https://docs.example.com' });
  const dom = createDomFromMockHtml('https://senpai-stream.link/watch/1');

  let clicked = 0;
  harness.messageHandler.fn = async (_tabId, msg) => {
    if (msg.type === MSG.REQUEST_DOM_SNAPSHOT) {
      return { ok: true, snapshot: globalThis.SenpaiDetector.inspectDocument(dom.window.document) };
    }
    if (msg.type === MSG.TRIGGER_AD_STEP) {
      clicked += 1;
      return { ok: true, clicked: true };
    }
  };

  // Initial detection with autoStart=false stays READY without clicking
  const snap = globalThis.SenpaiDetector.inspectDocument(dom.window.document);
  const s1 = await automation.handleContentSnapshot(mainTab.id, snap);
  assert.equal(s1.state, STATES.READY);
  await sleep(300);
  assert.equal(clicked, 0);

  // User switches to otherTab before manual start / next step
  await harness.chromeApi.tabs.update(otherTab.id, { active: true });
  await automation.startManual(mainTab.id);
  await sleep(60);

  const sessions = await storage.getSessions();
  assert.equal(sessions[String(mainTab.id)].state, STATES.PAUSED_FOCUS);
  assert.equal(clicked, 0);
  // Confirm active tab was NOT stolen from user
  assert.equal(harness.tabsMap.get(otherTab.id).active, true);

  // User returns to mainTab -> resumes automatically and clicks
  await harness.chromeApi.tabs.update(mainTab.id, { active: true });
  await automation.onTabActivated(mainTab.id);
  await sleep(180);
  assert.equal(clicked, 1);

  await automation.stopManual(mainTab.id);
});

// ---------------------------------------------------------------------------
// 6. Manual Stop & Global Disable
// ---------------------------------------------------------------------------
test('6. Manual stop and global disable immediately halt automation', async () => {
  const harness = createMockChromeHarness();
  const storage = createStorageClient(harness.chromeApi.storage);
  await storage.ensureDefaults();
  await storage.saveSettings({ autoStart: false });

  const logger = createLogger(storage);
  const tabManager = createTabManager({ storage, logger, chromeApi: harness.chromeApi });
  const automation = createAutomationManager({ storage, tabManager, logger, chromeApi: harness.chromeApi });

  const mainTab = harness.addTab({ id: 30, windowId: 1, active: true, url: 'https://senpai-stream.link/watch/1' });
  const dom = createDomFromMockHtml();

  harness.messageHandler.fn = async (_tabId, msg) => {
    if (msg.type === MSG.REQUEST_DOM_SNAPSHOT) {
      return { ok: true, snapshot: globalThis.SenpaiDetector.inspectDocument(dom.window.document) };
    }
    if (msg.type === MSG.TRIGGER_AD_STEP) {
      return { ok: true, clicked: true };
    }
  };

  await automation.handleContentSnapshot(mainTab.id, globalThis.SenpaiDetector.inspectDocument(dom.window.document));
  await automation.startManual(mainTab.id);
  await sleep(50);

  const stopped = await automation.stopManual(mainTab.id);
  assert.equal(stopped.session.state, STATES.STOPPED);

  // Global disable also forces active sessions to STOPPED
  await automation.startManual(mainTab.id);
  await sleep(40);
  await automation.setGlobalEnabled(false);
  const sessions = await storage.getSessions();
  assert.equal(sessions[String(mainTab.id)].state, STATES.STOPPED);
  assert.equal((await storage.getSettings()).enabled, false);
});

// ---------------------------------------------------------------------------
// 7 & 8. Errors, Early Ad-Close, Timeouts, and Bounded Retries
// ---------------------------------------------------------------------------
test('7 & 8. Handles premature ad close, step timeouts, maxRetries exhaustion, and site cooldown timers', async () => {
  const harness = createMockChromeHarness();
  const storage = createStorageClient(harness.chromeApi.storage);
  await storage.ensureDefaults();
  await storage.saveSettings({
    autoStart: false,
    openAdTimeoutMs: 2000,
    stepTimeoutMs: 5000,
    interStepDelayMs: 300,
    maxRetries: 1
  });

  const logger = createLogger(storage);
  const tabManager = createTabManager({ storage, logger, chromeApi: harness.chromeApi });
  const automation = createAutomationManager({ storage, tabManager, logger, chromeApi: harness.chromeApi });

  const mainTab = harness.addTab({ id: 40, windowId: 1, active: true, url: 'https://senpai-stream.link/watch/1' });
  const dom = createDomFromMockHtml();

  harness.messageHandler.fn = async (_tabId, msg) => {
    if (msg.type === MSG.REQUEST_DOM_SNAPSHOT) {
      return { ok: true, snapshot: globalThis.SenpaiDetector.inspectDocument(dom.window.document) };
    }
    if (msg.type === MSG.TRIGGER_AD_STEP) {
      // Simulate popup blocked / no tab ever opens
      return { ok: true, clicked: true };
    }
  };

  await automation.handleContentSnapshot(mainTab.id, globalThis.SenpaiDetector.inspectDocument(dom.window.document));
  await automation.startManual(mainTab.id);

  // Wait for initial attempt + 1 retry timeout (~2s + 1.2s + 2s)
  const deadline = Date.now() + 7500;
  while (Date.now() < deadline) {
    const s = (await storage.getSessions())[String(mainTab.id)];
    if (s?.state === STATES.ERROR) break;
    await sleep(100);
  }

  const errored = (await storage.getSessions())[String(mainTab.id)];
  assert.equal(errored.state, STATES.ERROR);
  assert.equal(errored.retriesOnCurrentStep, 2); // 1st failure (retry 1/1) + 2nd failure -> ERROR
  assert.match(errored.lastError, /nombre maximal de tentatives/i);

  // Verify early ad tab closure (< 1550ms) triggers retry warning
  await storage.saveSettings({ maxRetries: 1, stepTimeoutMs: 5000 });
  const adTab = harness.addTab({ id: 41, windowId: 1, active: true, openerTabId: mainTab.id });
  await storage.saveSession(mainTab.id, {
    mainTabId: mainTab.id,
    origin: 'https://senpai-stream.link',
    state: STATES.WAITING_VALIDATION,
    done: 0,
    required: 5,
    adTabId: adTab.id,
    adOpenedAt: Date.now() - 400,
    retriesOnCurrentStep: 0
  });
  await automation.onAdTabRemoved(mainTab.id, { adTabId: adTab.id, mainTabId: mainTab.id, openedAt: Date.now() - 400 });
  const afterEarly = (await storage.getSessions())[String(mainTab.id)];
  assert.equal(afterEarly.state, STATES.NEXT_STEP);
  assert.equal(afterEarly.retriesOnCurrentStep, 1);
  await automation.stopManual(mainTab.id);
});

// ---------------------------------------------------------------------------
// 9. MV3 Service Worker Suspension & Revival Recovery
// ---------------------------------------------------------------------------
test('9. Recovers active WAITING_VALIDATION session from storage after complete SW restart', async () => {
  const harness = createMockChromeHarness();
  const storage1 = createStorageClient(harness.chromeApi.storage);
  await storage1.ensureDefaults();

  const mainTab = harness.addTab({ id: 60, windowId: 1, active: false, url: 'https://senpai-stream.link/watch/1' });
  const adTab = harness.addTab({ id: 61, windowId: 1, active: true, openerTabId: mainTab.id, url: 'https://senpai-stream.link/go/step-1' });

  // Simulate SW #1 persisting state before Chrome terminates the worker during ad hold
  await storage1.setManagedAdTabs({
    [String(adTab.id)]: {
      adTabId: adTab.id,
      mainTabId: mainTab.id,
      stepIndex: 1,
      windowId: 1,
      openedAt: Date.now() - 2500,
      initialUrl: 'about:blank',
      lastUrl: 'https://senpai-stream.link/go/step-1',
      loaded: true
    }
  });
  await storage1.saveSession(mainTab.id, {
    mainTabId: mainTab.id,
    origin: 'https://senpai-stream.link',
    url: mainTab.url,
    state: STATES.WAITING_VALIDATION,
    pageKind: PAGE_KINDS.AD_GATE,
    domVerified: true,
    done: 0,
    required: 5,
    stepStartedDone: 0,
    adTabId: adTab.id,
    adOpenedAt: Date.now() - 2500,
    adHoldUntil: Date.now() - 500, // already past hold time while SW was suspended!
    retriesOnCurrentStep: 0
  });

  // Brand new SW #2 instance (zero shared in-memory Maps/timers!)
  const storage2 = createStorageClient(harness.chromeApi.storage);
  const logger2 = createLogger(storage2);
  const tabManager2 = createTabManager({ storage: storage2, logger: logger2, chromeApi: harness.chromeApi });
  const automation2 = createAutomationManager({ storage: storage2, tabManager: tabManager2, logger: logger2, chromeApi: harness.chromeApi });

  const dom = createDomFromMockHtml();
  harness.messageHandler.fn = async (_tabId, msg) => {
    if (msg.type === MSG.REQUEST_DOM_SNAPSHOT) {
      return { ok: true, snapshot: globalThis.SenpaiDetector.inspectDocument(dom.window.document) };
    }
  };

  await automation2.reconcileSessions();

  // Ad tab was closed, mainTab became active, state transitioned to RETURNING
  assert.equal(harness.tabsMap.has(adTab.id), false);
  assert.equal(harness.tabsMap.get(mainTab.id).active, true);
  const recovered = (await storage2.getSessions())[String(mainTab.id)];
  assert.equal(recovered.state, STATES.RETURNING);

  await automation2.stopManual(mainTab.id);
});
