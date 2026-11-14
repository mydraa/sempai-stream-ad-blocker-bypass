import { MSG, PAGE_KINDS, STATES } from '../shared/constants.js';
import { sendRuntimeMessage } from '../shared/messaging.js';

const ACTIVE_STATES = new Set([
  STATES.OPENING_AD,
  STATES.WAITING_VALIDATION,
  STATES.RETURNING,
  STATES.NEXT_STEP
]);

const els = {
  globalStatusPill: document.getElementById('global-status-pill'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  footerSettingsBtn: document.getElementById('footer-settings-btn'),
  domainAuthBadge: document.getElementById('domain-auth-badge'),
  currentHostname: document.getElementById('current-hostname'),
  domainHelperText: document.getElementById('domain-helper-text'),
  addDomainContainer: document.getElementById('add-domain-container'),
  addCurrentDomainBtn: document.getElementById('add-current-domain-btn'),
  counterText: document.getElementById('counter-text'),
  stepSegments: document.getElementById('step-segments'),
  stepProgress: document.getElementById('step-progress'),
  currentStepLabel: document.getElementById('current-step-label'),
  automationStateLabel: document.getElementById('automation-state-label'),
  alertBox: document.getElementById('alert-box'),
  toggleEnabledBtn: document.getElementById('toggle-enabled-btn'),
  startManualBtn: document.getElementById('start-manual-btn'),
  stopNowBtn: document.getElementById('stop-now-btn'),
  liveAnnouncer: document.getElementById('live-announcer')
};

let currentTabId = null;
let pendingOrigin = null;
let pendingOriginPattern = null;
let lastAnnouncement = '';

function announce(text) {
  if (!text || text === lastAnnouncement) return;
  lastAnnouncement = text;
  els.liveAnnouncer.textContent = text;
}

function setPill(el, variant, text) {
  el.className = `pill pill-${variant}`;
  el.textContent = text;
}

function setBadge(el, variant, text) {
  el.className = `badge badge-${variant}`;
  el.textContent = text;
}

function renderSegments(done, required, isActiveRun) {
  const total = Math.max(1, required || 5);
  const completed = Math.max(0, Math.min(total, done || 0));
  const nodes = Array.from(els.stepSegments.children);
  nodes.forEach((node, idx) => {
    node.classList.remove('is-done', 'is-active');
    if (idx < completed) {
      node.classList.add('is-done');
    } else if (isActiveRun && idx === completed) {
      node.classList.add('is-active');
    }
  });
  els.stepProgress.max = total;
  els.stepProgress.value = completed;
  els.stepProgress.textContent = `${completed}/${total}`;
}

function renderAlert(variant, message) {
  if (!message) {
    els.alertBox.hidden = true;
    els.alertBox.textContent = '';
    els.alertBox.className = 'alert-box';
    return;
  }
  els.alertBox.hidden = false;
  els.alertBox.className = `alert-box is-${variant}`;
  els.alertBox.textContent = message;
}

function renderState(payload) {
  if (!payload?.ok) {
    setPill(els.globalStatusPill, 'danger', 'Indisponible');
    renderAlert('error', payload?.error || 'Impossible de communiquer avec le service worker.');
    return;
  }

  const { settings, domainInfo, session } = payload;
  const enabled = Boolean(settings?.enabled);

  // Global status pill & toggle button
  if (enabled) {
    setPill(els.globalStatusPill, 'ok', 'Activée');
    els.toggleEnabledBtn.textContent = 'Désactiver l’automatisation';
  } else {
    setPill(els.globalStatusPill, 'danger', 'Désactivée');
    els.toggleEnabledBtn.textContent = 'Activer l’automatisation';
  }
  els.toggleEnabledBtn.dataset.nextEnabled = String(!enabled);

  // Domain info
  els.currentHostname.textContent = domainInfo?.hostname || 'Aucun onglet web actif';
  pendingOrigin = domainInfo?.origin || null;
  pendingOriginPattern = domainInfo?.originPattern || null;

  if (!domainInfo?.origin) {
    setBadge(els.domainAuthBadge, 'neutral', 'Page système');
    els.domainHelperText.textContent = 'Ouvrez un épisode sur Senpai Stream pour commencer.';
    els.addDomainContainer.hidden = true;
  } else if (domainInfo.isAuthorized) {
    if (!domainInfo.domainEnabled) {
      setBadge(els.domainAuthBadge, 'warn', 'Domaine en pause');
      els.domainHelperText.textContent = 'Ce domaine est autorisé mais désactivé dans les paramètres.';
    } else if (session?.domVerified || domainInfo.domVerified) {
      setBadge(els.domainAuthBadge, 'ok', 'Autorisé & vérifié');
      els.domainHelperText.textContent = 'Structure Senpai Stream reconnue.';
    } else {
      setBadge(els.domainAuthBadge, 'ok', 'Autorisé');
      els.domainHelperText.textContent = 'Domaine autorisé. Vérification DOM selon la page affichée.';
    }
    els.addDomainContainer.hidden = true;
  } else if (domainInfo.isCandidate) {
    setBadge(els.domainAuthBadge, 'warn', 'Nouveau domaine détecté');
    els.domainHelperText.textContent = 'Ce domaine ressemble à Senpai Stream mais n’est pas encore autorisé.';
    els.addDomainContainer.hidden = false;
    els.addCurrentDomainBtn.textContent = `Autoriser ${domainInfo.hostname}`;
  } else {
    setBadge(els.domainAuthBadge, 'neutral', 'Non autorisé');
    els.domainHelperText.textContent = 'Domaine non reconnu comme Senpai Stream.';
    els.addDomainContainer.hidden = false;
    els.addCurrentDomainBtn.textContent = 'Ajouter le domaine actuel';
  }

  // Progression & state
  const done = typeof session?.done === 'number' ? session.done : 0;
  const required = typeof session?.required === 'number' && session.required > 0 ? session.required : 5;
  const state = session?.state || STATES.IDLE;
  const isRunning = ACTIVE_STATES.has(state);

  els.counterText.textContent = session ? `${done}/${required}` : '0/5';
  renderSegments(done, required, isRunning);

  if (!session || session.pageKind === PAGE_KINDS.SITE_HOME_OR_OTHER || session.pageKind === PAGE_KINDS.UNKNOWN) {
    els.currentStepLabel.textContent = domainInfo?.isAuthorized
      ? 'Ouvrez une page d’épisode'
      : 'En attente';
  } else if (state === STATES.COMPLETED || session.pageKind === PAGE_KINDS.PLAYER_UNLOCKED) {
    els.currentStepLabel.textContent = 'Lecteur prêt';
  } else {
    const stepNum = Math.min(required, done + 1);
    els.currentStepLabel.textContent = `Publicité ${stepNum} sur ${required}`;
  }

  els.automationStateLabel.textContent = session?.stateLabel || 'Inactif';

  if (session?.state === STATES.ERROR) {
    renderAlert('error', session.lastError || 'Une erreur est survenue lors du parcours.');
    announce(`Erreur : ${session.lastError || 'parcours bloqué'}`);
  } else if (session?.state === STATES.PAUSED_FOCUS) {
    renderAlert('warn', 'En pause : revenez sur l’onglet Senpai Stream pour poursuivre sans voler le focus.');
  } else if (session?.state === STATES.COMPLETED) {
    renderAlert('ok', 'Toutes les publicités sont validées. Le lecteur vidéo est accessible.');
    announce('Toutes les publicités sont validées.');
  } else if (session?.lastError) {
    renderAlert('warn', session.lastError);
  } else if (session?.timerSeconds > 0) {
    renderAlert('warn', `Délai imposé par le site : ${session.timerSeconds} s restante(s).`);
  } else {
    renderAlert(null, '');
  }

  // Controls availability
  const canStart =
    Boolean(domainInfo?.isAuthorized) &&
    session?.pageKind === PAGE_KINDS.AD_GATE &&
    !isRunning &&
    state !== STATES.COMPLETED;

  els.startManualBtn.disabled = !canStart;
  els.stopNowBtn.disabled = !isRunning && state !== STATES.PAUSED_FOCUS;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  const res = await sendRuntimeMessage({
    type: MSG.GET_POPUP_STATE,
    tabId: currentTabId
  });
  renderState(res);
}

// Synchronous first-statement permission request preserves Chrome user gesture
els.addCurrentDomainBtn.addEventListener('click', () => {
  if (!pendingOriginPattern || !pendingOrigin) return;
  const originToGrant = pendingOrigin;
  const patternToGrant = pendingOriginPattern;
  const targetTabId = currentTabId;

  chrome.permissions.request({ origins: [patternToGrant] }).then(async (granted) => {
    if (!granted) {
      renderAlert('warn', 'Autorisation refusée par l’utilisateur.');
      return;
    }
    await sendRuntimeMessage({
      type: MSG.DOMAIN_AUTHORIZED,
      origin: originToGrant,
      tabId: targetTabId
    });
    await refresh();
  });
});

els.toggleEnabledBtn.addEventListener('click', async () => {
  const nextEnabled = els.toggleEnabledBtn.dataset.nextEnabled === 'true';
  await sendRuntimeMessage({ type: MSG.SET_ENABLED, enabled: nextEnabled });
  await refresh();
});

els.startManualBtn.addEventListener('click', async () => {
  if (typeof currentTabId !== 'number') return;
  const res = await sendRuntimeMessage({ type: MSG.START_AUTOMATION, tabId: currentTabId });
  if (!res?.ok && res?.error) {
    renderAlert('warn', res.error);
  }
  await refresh();
});

els.stopNowBtn.addEventListener('click', async () => {
  if (typeof currentTabId !== 'number') return;
  await sendRuntimeMessage({ type: MSG.STOP_AUTOMATION, tabId: currentTabId });
  await refresh();
});

function openSettings() {
  chrome.runtime.openOptionsPage();
}

els.openSettingsBtn.addEventListener('click', openSettings);
els.footerSettingsBtn.addEventListener('click', openSettings);

chrome.storage.onChanged.addListener(() => {
  refresh().catch(() => {});
});

document.addEventListener('DOMContentLoaded', async () => {
  await refresh();
  setInterval(() => {
    refresh().catch(() => {});
  }, 600);
});
