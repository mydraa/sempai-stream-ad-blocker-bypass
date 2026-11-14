(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'normal';
  const passId = Number(params.get('passId') || 5203269);
  const minSeconds = 1;
  const FERMETURE_EXPRESS = 1500;
  const ATTENTE_SANS_DEPART = 1500;

  document.getElementById('mock-origin').textContent = location.origin;
  document.getElementById('mock-scenario').textContent = scenario;

  let done = Number(params.get('initialDone') || 0);
  const required = 5;
  let unlocked = done >= required;

  let adWindow = null;
  let watcher = null;
  let openedAt = 0;
  let armed = false;
  let horsTotal = 0;
  let horsDepuis = null;
  let cachePrecedent = document.hidden;
  let focusSuspect = false;
  let tooFastTriggeredOnce = false;

  const overlay = document.getElementById('adgate-overlay');
  const wireEl = document.getElementById('adgate-livewire');
  const counterEl = document.getElementById('adgate-counter');
  const continueEl = document.getElementById('adgate-continue');
  const statusEl = document.getElementById('adgate-status');
  const timerEl = document.getElementById('adgate-timer');
  const timerValueEl = document.getElementById('adgate-timer-value');
  const reloadEl = document.getElementById('adgate-lien');
  const bars = Array.from(document.querySelectorAll('#adgate-bars > span'));

  function syncDom() {
    counterEl.textContent = `${done}/${required}`;
    bars.forEach((bar, idx) => {
      if (idx < done) {
        bar.classList.remove('bg-white/10');
        bar.classList.add('bg-primary-500');
      } else {
        bar.classList.add('bg-white/10');
        bar.classList.remove('bg-primary-500');
      }
    });
    const nextStep = Math.min(required, done + 1);
    continueEl.setAttribute('href', `/go/step-${nextStep}?passId=${passId}`);
    wireEl.setAttribute(
      'wire:snapshot',
      JSON.stringify({
        memo: { name: 'ad-gate' },
        data: { required, done, unlocked, passId }
      })
    );
    if (unlocked) {
      overlay.style.display = 'none';
    } else {
      overlay.style.display = 'flex';
    }
  }

  function horsPage() {
    const cache = document.hidden;
    if (cachePrecedent && !cache) focusSuspect = true;
    cachePrecedent = cache;
    const focus = document.hasFocus();
    if (focus) focusSuspect = false;
    return cache || (!focus && !focusSuspect);
  }

  function majPresence() {
    const dehors = horsPage();
    if (dehors && horsDepuis === null) horsDepuis = Date.now();
    if (!dehors && horsDepuis !== null) {
      horsTotal += Date.now() - horsDepuis;
      horsDepuis = null;
    }
  }

  function vu() {
    return horsTotal + (horsDepuis !== null ? Date.now() - horsDepuis : 0);
  }

  function revenu() {
    return !horsPage();
  }

  function stopWatching() {
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
    }
  }

  function startCountdown(seconds, onComplete) {
    let rem = seconds;
    timerEl.style.display = 'block';
    timerValueEl.textContent = String(rem);
    const id = setInterval(() => {
      rem -= 1;
      if (rem <= 0) {
        clearInterval(id);
        timerEl.style.display = 'none';
        timerValueEl.textContent = '0';
        onComplete();
      } else {
        timerValueEl.textContent = String(rem);
      }
    }, 1000);
  }

  async function attempt() {
    if (!armed) return;
    armed = false;

    try {
      const res = await fetch('/api/ad-clicked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passId,
          step: done + 1,
          scenario,
          vuMs: vu(),
          tooFastTriggeredOnce
        })
      });

      if (!res.ok) {
        statusEl.textContent = `Erreur réseau serveur (${res.status})`;
        return;
      }

      const data = await res.json();
      if (data.ok) {
        done = data.done;
        unlocked = done >= required;
        statusEl.textContent = '';
        syncDom();
        return;
      }

      if (data.reason === 'too_fast') {
        tooFastTriggeredOnce = true;
        statusEl.textContent = `Retourne sur la publicité : encore ${data.wait} s`;
        startCountdown(data.wait, () => {
          armed = true;
          attempt();
        });
        return;
      }

      if (data.reason === 'page_expiree') {
        statusEl.textContent = 'Page expirée. Recharge la page pour continuer.';
        reloadEl.style.display = 'inline-block';
        return;
      }

      statusEl.textContent = data.message || 'Validation non confirmée par le serveur.';
    } catch {
      statusEl.textContent = 'Erreur réseau lors de la validation.';
    }
  }

  function tic() {
    majPresence();
    if (!armed) {
      stopWatching();
      return;
    }

    if (adWindow && adWindow.closed) {
      const openDuration = Date.now() - openedAt;
      if (openDuration <= FERMETURE_EXPRESS && scenario !== 'skip_express_check') {
        armed = false;
        stopWatching();
        statusEl.textContent = 'Onglet fermé trop tôt (bloqueur détecté).';
        return;
      }
    }

    const restant = Math.max(0, minSeconds * 1000 - vu());
    if (restant <= 0 && revenu() && (vu() > 0 || Date.now() - openedAt >= ATTENTE_SANS_DEPART)) {
      stopWatching();
      attempt();
    }
  }

  function startWatching(win) {
    adWindow = win;
    openedAt = Date.now();
    horsTotal = 0;
    horsDepuis = null;
    armed = true;
    majPresence();
    stopWatching();
    watcher = setInterval(tic, 250);
  }

  function openAdWindow(href) {
    const win = window.open('about:blank', '_blank');
    if (!win) {
      statusEl.textContent = 'Popup bloquée par le navigateur.';
      return null;
    }
    try {
      win.opener = null;
      win.document.write('<!doctype html><title>Chargement…</title><p>Chargement de la publicité…</p>');
      win.document.close();
      win.location.href = href;
    } catch {
      // Ignore cross-origin window errors
    }
    return win;
  }

  document.addEventListener('visibilitychange', majPresence);
  window.addEventListener('blur', majPresence);
  window.addEventListener('focus', majPresence);

  continueEl.addEventListener('click', (e) => {
    e.preventDefault();
    statusEl.textContent = '';
    const href = continueEl.getAttribute('href');
    const win = openAdWindow(href);
    if (win) {
      startWatching(win);
    }
  });

  syncDom();
})();
