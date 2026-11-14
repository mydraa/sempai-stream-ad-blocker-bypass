import { sanitizeUrlForLog } from './domain-utils.js';

const SENSITIVE_KEY_RE = /(cookie|token|secret|password|authorization|auth|session)/i;

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const clean = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      clean[key] = '[masqué]';
      continue;
    }
    if (typeof value === 'string') {
      clean[key] = /^https?:\/\//i.test(value) ? sanitizeUrlForLog(value) : value.slice(0, 240);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      clean[key] = value;
    } else {
      clean[key] = String(value).slice(0, 120);
    }
  }
  return clean;
}

export function createLogger(storageClient) {
  let writeChain = Promise.resolve();

  function log(level, component, message, meta) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      component,
      message: String(message).slice(0, 300),
      meta: sanitizeMeta(meta)
    };
    // Serialize log appends to prevent lost updates across concurrent events
    writeChain = writeChain
      .then(() => storageClient.appendLogEntry(entry))
      .catch(() => {});
    return writeChain;
  }

  return {
    info: (component, message, meta) => log('info', component, message, meta),
    warn: (component, message, meta) => log('warn', component, message, meta),
    error: (component, message, meta) => log('error', component, message, meta),
    flush: () => writeChain
  };
}
