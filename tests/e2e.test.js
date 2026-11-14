import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { createMockServer } from './mock-site/server.js';
import '../src/shared/protocol.global.js';
import { PAGE_KINDS } from '../src/shared/constants.js';
import '../src/content/selectors.js';
import '../src/content/detector.js';
import '../src/content/progression.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('E2E-1: Manifest V3 files, icons, popup HTML, and settings HTML exist and pass structural checks', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://senpai-stream.link/*']);

  for (const iconRel of Object.values(manifest.icons)) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, iconRel)), true, `Missing icon ${iconRel}`);
  }
  assert.equal(fs.existsSync(path.join(REPO_ROOT, manifest.action.default_popup)), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, manifest.options_ui.page)), true);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, manifest.background.service_worker)), true);

  for (const csFile of manifest.content_scripts[0].js) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, csFile)), true, `Missing content script ${csFile}`);
  }

  // Verify no inline event handlers or inline scripts in popup.html / settings.html
  for (const htmlRel of [manifest.action.default_popup, manifest.options_ui.page]) {
    const html = fs.readFileSync(path.join(REPO_ROOT, htmlRel), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    assert.equal(doc.documentElement.getAttribute('lang'), 'fr');
    assert.equal(doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content'), 'dark');
    const scripts = Array.from(doc.querySelectorAll('script'));
    assert.equal(scripts.every((s) => Boolean(s.getAttribute('src'))), true);
  }
});

test('E2E-2: Mock HTTP server serves watch page, handles /go/ redirects, and validates 0/5 -> 5/5', async () => {
  const primary = createMockServer({ host: '127.0.0.1', port: 0 });
  const mirror = createMockServer({ host: '127.0.0.1', port: 0 });
  const srv1 = await primary.start();
  const srv2 = await mirror.start();

  try {
    // 1. Fetch watch page from primary origin and verify detector recognizes AD_GATE
    const watchRes = await fetch(`${srv1.origin}/watch?scenario=normal`);
    assert.equal(watchRes.status, 200);
    const html = await watchRes.text();
    const dom = new JSDOM(html, { url: `${srv1.origin}/watch?scenario=normal`, pretendToBeVisual: true });
    const snap = globalThis.SenpaiDetector.inspectDocument(dom.window.document);
    assert.equal(snap.pageKind, PAGE_KINDS.AD_GATE);
    assert.equal(snap.done, 0);
    assert.equal(snap.required, 5);

    // 2. Walk through steps 1..5 against the real HTTP server endpoints
    for (let step = 1; step <= 5; step++) {
      const goRes = await fetch(`${srv1.origin}/go/step-${step}?passId=5203269`, { redirect: 'manual' });
      assert.equal(goRes.status, 302);
      assert.equal(goRes.headers.get('location'), `/ad.html?step=${step}`);

      const validateRes = await fetch(`${srv1.origin}/api/ad-clicked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passId: 5203269,
          step,
          scenario: 'normal',
          vuMs: 1800,
          tooFastTriggeredOnce: false
        })
      });
      const data = await validateRes.json();
      assert.equal(data.ok, true);
      assert.equal(data.done, step);
    }

    // 3. Verify simulated domain change on mirror server works identically
    const mirrorRes = await fetch(`${srv2.origin}/watch?scenario=normal`);
    const mirrorHtml = await mirrorRes.text();
    const mirrorDom = new JSDOM(mirrorHtml, { url: `${srv2.origin}/watch?scenario=normal`, pretendToBeVisual: true });
    const mirrorSnap = globalThis.SenpaiDetector.inspectDocument(mirrorDom.window.document);
    assert.equal(mirrorSnap.pageKind, PAGE_KINDS.AD_GATE);
    assert.equal(mirrorSnap.domVerified, true);
  } finally {
    await primary.stop();
    await mirror.stop();
  }
});

test('E2E-3: Mock server enforces too_fast, stuck, expired, and network_error scenarios', async () => {
  const srv = createMockServer({ host: '127.0.0.1', port: 0 });
  const { origin } = await srv.start();

  try {
    await fetch(`${origin}/go/step-1?passId=100`, { redirect: 'manual' });

    // too_fast scenario returns wait: 2 on first attempt
    const rFast = await fetch(`${origin}/api/ad-clicked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passId: 100, step: 1, scenario: 'too_fast', vuMs: 1800, tooFastTriggeredOnce: false })
    }).then((r) => r.json());
    assert.equal(rFast.ok, false);
    assert.equal(rFast.reason, 'too_fast');
    assert.equal(rFast.wait, 2);

    // stuck scenario never validates
    const rStuck = await fetch(`${origin}/api/ad-clicked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passId: 100, step: 1, scenario: 'stuck', vuMs: 1800 })
    }).then((r) => r.json());
    assert.equal(rStuck.ok, false);
    assert.equal(rStuck.reason, 'not_opened');

    // expired scenario on step 2
    const rExp = await fetch(`${origin}/api/ad-clicked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passId: 100, step: 2, scenario: 'expired', vuMs: 1800 })
    }).then((r) => r.json());
    assert.equal(rExp.ok, false);
    assert.equal(rExp.reason, 'page_expiree');

    // network_error scenario returns HTTP 500
    const rErr = await fetch(`${origin}/api/ad-clicked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passId: 100, step: 1, scenario: 'network_error', vuMs: 1800 })
    });
    assert.equal(rErr.status, 500);
  } finally {
    await srv.stop();
  }
});
