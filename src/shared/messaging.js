/**
 * Safe chrome.runtime / chrome.tabs messaging wrappers.
 */

export async function sendRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: err?.message || 'Communication service worker indisponible.' };
  }
}

export async function sendTabMessage(tabId, message) {
  if (typeof tabId !== 'number' || tabId < 0) {
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}
