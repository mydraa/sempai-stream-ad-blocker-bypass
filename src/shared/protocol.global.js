(function (root) {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'IDLE',
    DETECTING: 'DETECTING',
    READY: 'READY',
    OPENING_AD: 'OPENING_AD',
    WAITING_VALIDATION: 'WAITING_VALIDATION',
    RETURNING: 'RETURNING',
    NEXT_STEP: 'NEXT_STEP',
    PAUSED_FOCUS: 'PAUSED_FOCUS',
    COMPLETED: 'COMPLETED',
    ERROR: 'ERROR',
    STOPPED: 'STOPPED'
  });

  const STATE_LABELS_FR = Object.freeze({
    [STATES.IDLE]: 'Inactif',
    [STATES.DETECTING]: 'Détection en cours',
    [STATES.READY]: 'Prêt',
    [STATES.OPENING_AD]: 'Ouverture publicité',
    [STATES.WAITING_VALIDATION]: 'Attente de validation',
    [STATES.RETURNING]: 'Retour onglet principal',
    [STATES.NEXT_STEP]: 'Étape suivante',
    [STATES.PAUSED_FOCUS]: 'En pause (onglet changé)',
    [STATES.COMPLETED]: 'Terminé',
    [STATES.ERROR]: 'Erreur',
    [STATES.STOPPED]: 'Arrêté'
  });

  const PAGE_KINDS = Object.freeze({
    AD_GATE: 'AD_GATE',
    PLAYER_UNLOCKED: 'PLAYER_UNLOCKED',
    SITE_HOME_OR_OTHER: 'SITE_HOME_OR_OTHER',
    UNKNOWN: 'UNKNOWN'
  });

  const FOCUS_POLICIES = Object.freeze({
    RESPECTFUL: 'respectful',
    AUTO_SWITCH: 'auto_switch'
  });

  const MSG = Object.freeze({
    CONTENT_READY: 'SENPAI_CONTENT_READY',
    DOM_SNAPSHOT: 'SENPAI_DOM_SNAPSHOT',
    TRIGGER_AD_STEP: 'SENPAI_TRIGGER_AD_STEP',
    REQUEST_DOM_SNAPSHOT: 'SENPAI_REQUEST_DOM_SNAPSHOT',
    PING: 'SENPAI_PING',
    GET_POPUP_STATE: 'SENPAI_GET_POPUP_STATE',
    START_AUTOMATION: 'SENPAI_START_AUTOMATION',
    STOP_AUTOMATION: 'SENPAI_STOP_AUTOMATION',
    SET_ENABLED: 'SENPAI_SET_ENABLED',
    DOMAIN_AUTHORIZED: 'SENPAI_DOMAIN_AUTHORIZED',
    DOMAIN_REMOVED: 'SENPAI_DOMAIN_REMOVED',
    TOGGLE_DOMAIN_ENABLED: 'SENPAI_TOGGLE_DOMAIN_ENABLED',
    GET_SETTINGS: 'SENPAI_GET_SETTINGS',
    UPDATE_SETTINGS: 'SENPAI_UPDATE_SETTINGS',
    GET_LOGS: 'SENPAI_GET_LOGS',
    CLEAR_LOGS: 'SENPAI_CLEAR_LOGS',
    REVERIFY_TAB: 'SENPAI_REVERIFY_TAB'
  });

  const BUILTIN_ORIGIN = 'https://senpai-stream.link';

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoStart: true,
    autoCloseAdTabs: true,
    notifyOnComplete: true,
    focusPolicy: FOCUS_POLICIES.RESPECTFUL,
    adHoldMs: 2000,
    stepTimeoutMs: 20000,
    openAdTimeoutMs: 6000,
    interStepDelayMs: 700,
    maxRetries: 2,
    showLogsInSettings: true
  });

  const TIMING_CONSTANTS = Object.freeze({
    // Observed on live senpai-stream.link script: FERMETURE_EXPRESS = 1500ms, minSeconds = 1.
    MIN_SAFE_AD_HOLD_MS: 1650,
    MAX_LOGS: 250,
    WATCHDOG_ALARM_NAME: 'senpai-step-watchdog',
    WATCHDOG_PERIOD_MINUTES: 0.5
  });

  const CONTENT_SCRIPT_FILES = Object.freeze([
    'src/shared/protocol.global.js',
    'src/content/selectors.js',
    'src/content/detector.js',
    'src/content/progression.js',
    'src/content/content.js'
  ]);

  root.SenpaiProtocol = Object.freeze({
    STATES,
    STATE_LABELS_FR,
    PAGE_KINDS,
    FOCUS_POLICIES,
    MSG,
    BUILTIN_ORIGIN,
    DEFAULT_SETTINGS,
    TIMING_CONSTANTS,
    CONTENT_SCRIPT_FILES
  });
})(globalThis);
