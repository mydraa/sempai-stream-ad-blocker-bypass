import { DEFAULT_SETTINGS, FOCUS_POLICIES, MSG } from '../shared/constants.js';
import { normalizeOriginInput } from '../shared/domain-utils.js';
import { sendRuntimeMessage } from '../shared/messaging.js';

const els = {
  settingsForm: document.getElementById('settings-form'),
  saveBanner: document.getElementById('save-banner'),
  optEnabled: document.getElementById('opt-enabled'),
  optAutostart: document.getElementById('opt-autostart'),
  optAutoclose: document.getElementById('opt-autoclose'),
  optNotify: document.getElementById('opt-notify'),
  optShowLogs: document.getElementById('opt-show-logs'),
  focusRespectful: document.getElementById('focus-respectful'),
  focusAutoswitch: document.getElementById('focus-autoswitch'),
  optAdHold: document.getElementById('opt-ad-hold'),
  optStepTimeout: document.getElementById('opt-step-timeout'),
  optInterStep: document.getElementById('opt-inter-step'),
  optMaxRetries: document.getElementById('opt-max-retries'),
  resetDefaultsBtn: document.getElementById('reset-defaults-btn'),
  addDomainForm: document.getElementById('add-domain-form'),
  newDomainInput: document.getElementById('new-domain-input'),
  domainFeedback: document.getElementById('domain-feedback'),
  domainsTbody: document.getElementById('domains-tbody'),
  logsSection: document.getElementById('logs-section'),
  logLevelFilter: document.getElementById('log-level-filter'),
  refreshLogsBtn: document.getElementById('refresh-logs-btn'),
  exportLogsBtn: document.getElementById('export-logs-btn'),
  clearLogsBtn: document.getElementById('clear-logs-btn'),
  logsList: document.getElementById('logs-list')
};

let currentLogs = [];

function syncAriaValidation(input) {
  if (!input?.matches?.('input')) return;
  const errorId = input.dataset.error;
  const invalid = input.matches(':user-invalid') || !input.validity.valid && input.classList.contains('user-invalid-fallback');
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  if (!errorId) return;
  const baseIds = (input.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (invalid) baseIds.push(errorId);
  if (baseIds.length) input.setAttribute('aria-describedby', baseIds.join(' '));
  else input.removeAttribute('aria-describedby');
}

function showBanner(text) {
  els.saveBanner.textContent = text;
  setTimeout(() => {
    if (els.saveBanner.textContent === text) {
      els.saveBanner.textContent = '';
    }
  }, 3000);
}

function populateSettings(settings) {
  els.optEnabled.checked = Boolean(settings.enabled);
  els.optAutostart.checked = Boolean(settings.autoStart);
  els.optAutoclose.checked = Boolean(settings.autoCloseAdTabs);
  els.optNotify.checked = Boolean(settings.notifyOnComplete);
  els.optShowLogs.checked = Boolean(settings.showLogsInSettings);
  els.focusRespectful.checked = settings.focusPolicy !== FOCUS_POLICIES.AUTO_SWITCH;
  els.focusAutoswitch.checked = settings.focusPolicy === FOCUS_POLICIES.AUTO_SWITCH;
  els.optAdHold.value = String(settings.adHoldMs);
  els.optStepTimeout.value = String(settings.stepTimeoutMs);
  els.optInterStep.value = String(settings.interStepDelayMs);
  els.optMaxRetries.value = String(settings.maxRetries);
  els.logsSection.hidden = !settings.showLogsInSettings;
}

function renderDomains(domains) {
  els.domainsTbody.textContent = '';
  for (const domain of domains) {
    const tr = document.createElement('tr');

    const tdOrigin = document.createElement('td');
    tdOrigin.textContent = domain.origin + (domain.builtIn ? ' (par défaut)' : '');
    tr.appendChild(tdOrigin);

    const tdStatus = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = `tag ${domain.domVerified ? 'tag-ok' : 'tag-neutral'}`;
    tag.textContent = domain.domVerified ? 'DOM vérifié' : 'En attente de visite';
    tdStatus.appendChild(tag);
    tr.appendChild(tdStatus);

    const tdToggle = document.createElement('td');
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = domain.enabled !== false ? 'Actif' : 'En pause';
    toggleBtn.addEventListener('click', async () => {
      const res = await sendRuntimeMessage({
        type: MSG.TOGGLE_DOMAIN_ENABLED,
        origin: domain.origin,
        enabled: domain.enabled === false
      });
      if (res?.ok) renderDomains(res.domains);
    });
    tdToggle.appendChild(toggleBtn);
    tr.appendChild(tdToggle);

    const tdActions = document.createElement('td');
    if (domain.builtIn) {
      const note = document.createElement('span');
      note.className = 'hint';
      note.textContent = 'Origine manifest';
      tdActions.appendChild(note);
    } else {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-danger btn-sm';
      delBtn.textContent = 'Supprimer';
      delBtn.addEventListener('click', async () => {
        const res = await sendRuntimeMessage({
          type: MSG.DOMAIN_REMOVED,
          origin: domain.origin
        });
        if (res?.ok) {
          renderDomains(res.domains);
          els.domainFeedback.textContent = `Domaine ${domain.origin} retiré.`;
        }
      });
      tdActions.appendChild(delBtn);
    }
    tr.appendChild(tdActions);

    els.domainsTbody.appendChild(tr);
  }
}

function renderLogs() {
  const filter = els.logLevelFilter.value;
  const filtered = filter === 'all' ? currentLogs : currentLogs.filter((l) => l.level === filter);
  els.logsList.textContent = '';

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Aucun journal enregistré pour ce filtre.';
    els.logsList.appendChild(empty);
    return;
  }

  for (let i = filtered.length - 1; i >= 0; i--) {
    const entry = filtered[i];
    const row = document.createElement('div');
    row.className = `log-entry level-${entry.level}`;

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    meta.textContent = `${entry.timestamp} • [${entry.component}] • ${entry.level.toUpperCase()}`;

    const msg = document.createElement('div');
    msg.textContent = entry.message + (entry.meta ? ` — ${JSON.stringify(entry.meta)}` : '');

    row.appendChild(meta);
    row.appendChild(msg);
    els.logsList.appendChild(row);
  }
}

async function loadAll() {
  const res = await sendRuntimeMessage({ type: MSG.GET_SETTINGS });
  if (res?.ok) {
    populateSettings(res.settings);
    renderDomains(res.domains || []);
  }
  const logsRes = await sendRuntimeMessage({ type: MSG.GET_LOGS });
  if (logsRes?.ok) {
    currentLogs = logsRes.logs || [];
    renderLogs();
  }
}

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const numberInputs = [els.optAdHold, els.optStepTimeout, els.optInterStep, els.optMaxRetries];
  for (const input of numberInputs) {
    if (!input.checkValidity()) {
      input.classList.add('user-invalid-fallback');
      syncAriaValidation(input);
      input.focus();
      return;
    }
  }

  const nextSettings = {
    enabled: els.optEnabled.checked,
    autoStart: els.optAutostart.checked,
    autoCloseAdTabs: els.optAutoclose.checked,
    notifyOnComplete: els.optNotify.checked,
    showLogsInSettings: els.optShowLogs.checked,
    focusPolicy: els.focusAutoswitch.checked ? FOCUS_POLICIES.AUTO_SWITCH : FOCUS_POLICIES.RESPECTFUL,
    adHoldMs: Number(els.optAdHold.value),
    stepTimeoutMs: Number(els.optStepTimeout.value),
    interStepDelayMs: Number(els.optInterStep.value),
    maxRetries: Number(els.optMaxRetries.value)
  };

  const res = await sendRuntimeMessage({ type: MSG.UPDATE_SETTINGS, settings: nextSettings });
  if (res?.ok) {
    populateSettings(res.settings);
    showBanner('Paramètres enregistrés.');
  }
});

els.resetDefaultsBtn.addEventListener('click', async () => {
  const res = await sendRuntimeMessage({ type: MSG.UPDATE_SETTINGS, settings: DEFAULT_SETTINGS });
  if (res?.ok) {
    populateSettings(res.settings);
    showBanner('Valeurs par défaut rétablies.');
  }
});

// Synchronous permission request before any await so user gesture is preserved
els.addDomainForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const desc = normalizeOriginInput(els.newDomainInput.value);
  if (!desc) {
    els.newDomainInput.setCustomValidity('Domaine invalide');
    els.newDomainInput.classList.add('user-invalid-fallback');
    syncAriaValidation(els.newDomainInput);
    els.newDomainInput.focus();
    return;
  }
  els.newDomainInput.setCustomValidity('');
  els.newDomainInput.classList.remove('user-invalid-fallback');
  syncAriaValidation(els.newDomainInput);

  chrome.permissions.request({ origins: [desc.originPattern] }).then(async (granted) => {
    if (!granted) {
      els.domainFeedback.textContent = `Autorisation Chrome refusée pour ${desc.origin}.`;
      return;
    }
    const res = await sendRuntimeMessage({ type: MSG.DOMAIN_AUTHORIZED, origin: desc.origin });
    if (res?.ok) {
      els.newDomainInput.value = '';
      renderDomains(res.domains);
      els.domainFeedback.textContent = `Domaine ${desc.origin} ajouté et autorisé.`;
    } else {
      els.domainFeedback.textContent = res?.error || 'Impossible d’ajouter ce domaine.';
    }
  });
});

els.newDomainInput.addEventListener('input', () => {
  els.newDomainInput.setCustomValidity('');
  els.newDomainInput.classList.remove('user-invalid-fallback');
  syncAriaValidation(els.newDomainInput);
});

for (const input of [els.optAdHold, els.optStepTimeout, els.optInterStep, els.optMaxRetries, els.newDomainInput]) {
  input.setAttribute('aria-invalid', 'false');
  input.addEventListener('blur', () => syncAriaValidation(input));
  input.addEventListener('input', () => {
    if (input.validity.valid) {
      input.classList.remove('user-invalid-fallback');
      syncAriaValidation(input);
    }
  });
}

els.logLevelFilter.addEventListener('change', renderLogs);

els.refreshLogsBtn.addEventListener('click', async () => {
  const res = await sendRuntimeMessage({ type: MSG.GET_LOGS });
  if (res?.ok) {
    currentLogs = res.logs || [];
    renderLogs();
  }
});

els.exportLogsBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentLogs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `senpai-automation-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

els.clearLogsBtn.addEventListener('click', async () => {
  await sendRuntimeMessage({ type: MSG.CLEAR_LOGS });
  currentLogs = [];
  renderLogs();
});

document.addEventListener('DOMContentLoaded', loadAll);
