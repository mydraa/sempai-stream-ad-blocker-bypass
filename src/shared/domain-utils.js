/**
 * Domain parsing, candidate recognition, and privacy-safe log sanitization helpers.
 */

const CANDIDATE_HOSTNAME_RE = /^(?:[a-z0-9-]+\.)*se[mn]pai[-_.]?stream\.[a-z0-9-]{2,}$/i;
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Parses a URL string safely without throwing.
 * @param {string} rawUrl
 * @returns {URL | null}
 */
export function parseUrlSafe(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    return new URL(rawUrl.trim());
  } catch {
    return null;
  }
}

/**
 * Normalizes a user-supplied domain or URL into an origin descriptor suitable for chrome.permissions.
 * Remote origins require HTTPS; HTTP is restricted to localhost / 127.0.0.1 for local testing.
 * @param {string} input
 * @returns {{ origin: string, originPattern: string, hostname: string, isLocalhost: boolean } | null}
 */
export function normalizeOriginInput(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Reject dangerous schemes explicitly
  if (/^(javascript|data|file|chrome|chrome-extension|about):/i.test(trimmed)) {
    return null;
  }

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    const bareHost = candidate.split('/')[0].split(':')[0].toLowerCase();
    const scheme = LOCALHOST_HOSTS.has(bareHost) ? 'http://' : 'https://';
    candidate = scheme + candidate;
  }

  const parsed = parseUrlSafe(candidate);
  if (!parsed) return null;

  const isLocalhost = LOCALHOST_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    return null;
  }

  if (!parsed.hostname || (!parsed.hostname.includes('.') && !isLocalhost)) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  const origin = parsed.origin;
  return {
    origin,
    originPattern: `${origin}/*`,
    hostname,
    isLocalhost
  };
}

/**
 * Checks whether a hostname matches known Senpai Stream naming patterns.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isCandidateHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return false;
  return CANDIDATE_HOSTNAME_RE.test(hostname.trim().toLowerCase());
}

/**
 * Produces a deterministic, valid dynamic content-script ID for an origin.
 * @param {string} origin
 * @returns {string}
 */
export function getScriptIdForOrigin(origin) {
  const safe = String(origin)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `senpai-domain-${safe}`;
}

/**
 * Strips query parameters, hashes, and long opaque URL path tokens for safe diagnostic logging.
 * @param {string} rawUrl
 * @returns {string}
 */
export function sanitizeUrlForLog(rawUrl) {
  const parsed = parseUrlSafe(rawUrl);
  if (!parsed) return '[url-invalide]';
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${parsed.protocol}//[restreint]`;
  }
  const safeSegments = parsed.pathname
    .split('/')
    .map((segment) => (segment.length > 28 ? '[token]' : segment));
  return `${parsed.origin}${safeSegments.join('/')}`;
}
