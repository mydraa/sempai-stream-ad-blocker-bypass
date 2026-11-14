# Senpai Stream — Ad-Gate Automation (Chrome Manifest V3)

A lightweight, privacy-first **Google Chrome Manifest V3** extension (with a French dark-mode UI) designed to automate the 5-step ad gate on **Senpai Stream** while supporting dynamic domain changes without modifying extension code or reinstalling.

---

## 1. Key Features

- **5-Step Ad-Gate State Machine**: Automatically detects the ad gate (`0/5` → `5/5`), opens each ad step via real browser interaction, respects the site's minimum hold time, closes **only** the ad tabs it opened, returns to trigger validation, confirms DOM progression via `MutationObserver`, and stops once the video player is unlocked.
- **Dynamic Domain Management (MV3)**:
  - Recognizes candidate `senpai-stream.*` (and `sempai-stream.*`) domains automatically and flags them with a `+` badge.
  - Uses per-origin `optional_host_permissions` (`chrome.permissions.request`) and dynamic script registration (`chrome.scripting.registerContentScripts`) instead of granting `<all_urls>`.
  - Verifies expected DOM markers before running any automation on a newly authorized domain.
  - Centralizes all DOM selectors in [`src/content/selectors.js`](src/content/selectors.js) for fast maintenance if the site layout changes.
- **Strict Tab Ownership**: Tracks only tabs created during `OPENING_AD` (correlated via `openerTabId` / window timing) in `chrome.storage.session`. Never closes pre-existing personal tabs.
- **Focus-Respectful UX**:
  - **Respectful mode (default)**: Pauses cleanly (`PAUSED_FOCUS`) if you switch to another tab in the same window instead of stealing focus, and resumes automatically when you return.
  - **Auto-switch mode (optional)**: Briefly activates the Senpai Stream tab to trigger validation and restores your previous active tab.
- **MV3 Service Worker Resilience**: Zero authoritative state is stored in service worker global variables; session state lives in `chrome.storage.session` + `chrome.storage.local` with `chrome.alarms` watchdog reconciliation.
- **French Dark-Theme UI**: Modern accessible popup and full-page settings console with domain management, configurable timers/retries, and sanitized local diagnostic logs.

---

## 2. Technical Analysis: How Senpai Stream Works

Based on a read-only DOM and script inspection of `https://senpai-stream.link/`:

- **Stack**: Laravel + **Livewire 3** (`wire:id`, `wire:snapshot`, `wire:effects`) + **Alpine.js** (`x-data="{ unlocked: false }"`, `x-show="!unlocked"`) + **Vidstack** (`<media-player>`, `<media-provider>`).
- **Ad-Gate DOM Elements**:
  - Container: `[data-relay-state]`, `[wire:snapshot*="ad-gate"]`
  - Instructions: `#adgate-howto`
  - Progress bars: `#adgate-bars > span[data-index="0..4"]`
  - Counter: `#adgate-counter` (`0/5` … `5/5`)
  - Action button/link: `a#adgate-continue` (`href="https://.../go/<token>"`, `target="_blank"`)
  - Status / errors / countdown: `#adgate-status`, `#adgate-notice`, `#adgate-lien`, `#adgate-timer`, `#adgate-timer-value`
- **Visibility, Focus & Anti-Abuse Mechanics**:
  - Clicking `#adgate-continue` runs `window.open('about:blank', '_blank')`, clears `win.opener = null`, and navigates the new tab to `/go/<token>`.
  - The `/go/<token>` request registers server-side that the ad link was actually opened.
  - Client logic attaches `visibilitychange`, `blur`, and `focus` listeners and polls every `250 ms` (`tic()`):
    - `horsPage()` checks `document.hidden || (!document.hasFocus() && !focusSuspect)`.
    - `minSeconds = 1` (minimum away time before validation).
    - `FERMETURE_EXPRESS = 1500` ms: closing the ad tab in `<= 1500 ms` triggers auto-close/adblocker detection.
    - `PALIERS = [5000, 15000, 30000]` ms: burst-click rate limiting.
  - **Crucial Constraint**: `$wire.adClicked()` is only called by `tic()` once `vu() >= minSeconds * 1000` **and** `revenu()` (`!horsPage()`, i.e., the Senpai Stream tab becomes visible/active again).
  - Server Livewire responses handle `{ ok: true }`, `{ reason: 'too_fast', wait: N }`, `{ reason: 'not_opened' }`, and `{ reason: 'page_expiree' }`.

### Wait-Time Optimization & Browser Limitations

- **Why you cannot skip the ~1.65s wait**: Closing the ad tab under `1500 ms` trips `FERMETURE_EXPRESS`, and calling validation before the server records `/go/<token>` + `minSeconds` returns `not_opened` or `too_fast`. The extension defaults `adHoldMs` to `2000 ms` (minimum enforced floor `1650 ms`) and obeys any site-displayed `#adgate-timer` countdown without spoofing network requests.
- **Why Chrome cannot keep two tabs simultaneously active in one window**: Chrome exposes `document.visibilityState === 'visible'` for only one active tab per browser window. Therefore, if Senpai Stream and your active work tab share the **same** window, switching between the player tab and ad tab affects that window's active tab.
- **Recommended Workflow for Uninterrupted Browsing**: Place Senpai Stream in its **own dedicated Chrome window** while you work in another Chrome window. Because Chrome tracks one active tab per window and the extension never calls `chrome.windows.update(..., { focused: true })`, validation can proceed in the background window without stealing focus from your active window (note: Chrome's `window.open` behavior can still depend on window focus policies in some OS setups; if you work in the same window, the default **Respectueux du focus** mode pauses instead of hijacking your tab).

---

## 3. Project Structure

```text
sempai-stream-ad-blocker-bypass/
├── manifest.json
├── package.json
├── README.md
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── src/
│   ├── background/
│   │   ├── service-worker.js       # Top-level MV3 event listeners & message router
│   │   ├── tab-manager.js          # Managed ad-tab ownership, permissions, dynamic scripts
│   │   └── automation-manager.js   # Persistent 11-state machine & SW recovery
│   ├── content/
│   │   ├── selectors.js            # Centralized primary selectors & fallback heuristics
│   │   ├── detector.js             # Read-only DOM verification & snapshot extractor
│   │   ├── progression.js          # MutationObserver controller & single-flight click guard
│   │   └── content.js              # Content script entry point
│   ├── popup/
│   │   ├── popup.html              # French dark-mode popup UI
│   │   ├── popup.css
│   │   └── popup.js
│   ├── settings/
│   │   ├── settings.html           # French dark-mode settings, domains & logs page
│   │   ├── settings.css
│   │   └── settings.js
│   └── shared/
│       ├── protocol.global.js      # Shared states, message IDs, default settings
│       ├── constants.js            # ESM re-exports of protocol constants
│       ├── domain-utils.js         # Origin normalization, candidate regex, log sanitization
│       ├── storage.js              # chrome.storage.local & chrome.storage.session wrappers
│       ├── logger.js               # Privacy-safe local diagnostic logger
│       └── messaging.js            # Safe runtime/tab messaging helpers
└── tests/
    ├── mock-site/
    │   ├── index.html              # Local replica of Senpai Stream ad-gate UI
    │   ├── ad.html                 # Simulated ad destination tab
    │   ├── mock-site.js            # Exact visibility/focus/FERMETURE_EXPRESS logic
    │   └── server.js               # Dual-origin local HTTP mock server
    ├── automation.test.js          # Unit & integration test suite (node --test)
    └── e2e.test.js                 # Real Google Chrome MV3 E2E test suite (playwright-core)
```

---

## 4. State Machine

```text
IDLE / DETECTING
   │ (DOM verified: AD_GATE)
   ▼
 READY ──(autoStart or manual start)──▶ OPENING_AD
   ▲                                        │ (tabs.onCreated matched)
   │                                        ▼
PAUSED_FOCUS ◀─(user tab switch)── WAITING_VALIDATION (hold >= 1650ms & /go/ loaded)
   ▲                                        │
   │                                        ▼
   └────(retry <= maxRetries)─────── RETURNING (close managed adTab + activate mainTab)
                                            │
                       ┌────────────────────┴────────────────────┐
                       ▼ (done incremented < required)           ▼ (done >= required or player unlocked)
                   NEXT_STEP ──(interStepDelayMs)──▶ OPENING_AD   COMPLETED
                       │
                       ▼ (timeout / expired / retries exhausted)
                     ERROR

* STOP_AUTOMATION or global disable transitions immediately to STOPPED from any active state.
```

---

## 5. Installation in Google Chrome (`chrome://extensions`)

1. Clone or download this repository. No build step is required to load the extension.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (*Charger l'extension non empaquetée*).
5. Select the root folder of this repository (containing `manifest.json`).
6. Pin **Senpai Stream — Assistant Publicités** to your toolbar for quick access to progression, manual controls, and domain authorization.

### Adding a New Senpai Stream Domain

When Senpai Stream moves to a new domain (e.g., `senpai-stream.xyz`, `senpai-stream.to`, `senpai-stream.fr`):

1. Visit the new domain. If it matches `senpai-stream.*` / `sempai-stream.*`, the extension icon shows an amber `+` badge.
2. Open the extension popup and click **Autoriser ce domaine** (or add it manually in **Paramètres → Domaines Senpai Stream autorisés**).
3. Confirm Chrome's native permission prompt for that single origin.
4. The extension injects its script, verifies the DOM structure, and begins automating immediately.

---

## 6. Testing & Verification

### Running Automated Tests

Install development test dependencies (`jsdom`, `playwright-core`) — note that the extension runtime itself has **zero** third-party dependencies:

```bash
npm install
npm run validate:manifest
npm test
npm run test:e2e
```

### Running the Local Mock Site Manually

```bash
npm run mock-site
```

This starts two local HTTP servers (`http://127.0.0.1:4173/watch` and `http://localhost:4174/watch`) simulating domain migration as well as URL query scenarios:

- `?scenario=normal` — Full 0/5 → 5/5 progression with focus/visibility & `FERMETURE_EXPRESS` checks
- `?scenario=too_fast` — Simulates server `too_fast` cooldown timer (`#adgate-timer`)
- `?scenario=stuck` — Never validates step (tests timeout & `maxRetries`)
- `?scenario=expired` — Simulates `page_expiree` after step 1
- `?scenario=no_gate` — Simulates homepage without ad gate

### Verification Scope

- **Verified on live `https://senpai-stream.link/` (read-only inspection)**: Stack (`Livewire 3`, `Alpine.js`, `Vidstack`), DOM selectors (`#adgate-continue`, `#adgate-counter`, `#adgate-bars`, `#adgate-timer`, `#adgate-status`, `wire:snapshot`), and inline ad-gate timer/focus rules (`minSeconds = 1`, `FERMETURE_EXPRESS = 1500ms`, `horsPage()`, `$wire.adClicked()`).
- **Verified in automated tests (`tests/automation.test.js` & `tests/e2e.test.js`)**: DOM detection, dynamic candidate/origin management, real Chrome MV3 loading, French dark-mode popup & settings persistence, full `0/5 → 5/5` progression against the local mock server, strict ad-tab closure preserving pre-existing personal tabs, focus-switch pausing/resuming, manual stop, timeouts/retries, and service worker restart recovery.
- **Not run against live ads**: Actual ad-network redirects and live server `$wire.adClicked()` responses during a full 5-step run on `senpai-stream.link` were not executed automatically; live ad behaviors (such as unexpected ad popunders or site layout updates) should be checked interactively in Chrome, and selectors can be adjusted in [`src/content/selectors.js`](src/content/selectors.js).

---

## 7. Security & Privacy Guarantees

- **Minimal permissions**: `host_permissions` is scoped exclusively to `https://senpai-stream.link/*`; additional domains use explicit per-origin `optional_host_permissions`.
- **No data collection**: Zero analytics, zero remote scripts, zero `eval()`, zero network calls to external servers.
- **No sensitive access**: Never reads cookies, passwords, authentication tokens, or browsing history; diagnostic logs sanitize query strings and path tokens and remain local.
- **Safe interaction**: Never clicks payment buttons, notification prompts, or downloads; only activates the verified `#adgate-continue` `/go/` target inside a verified Senpai Stream ad-gate container.
