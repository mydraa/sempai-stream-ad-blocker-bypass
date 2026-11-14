import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const AD_HTML = fs.readFileSync(path.join(__dirname, 'ad.html'), 'utf8');
const MOCK_JS = fs.readFileSync(path.join(__dirname, 'mock-site.js'), 'utf8');

const HOME_HTML = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Senpai-Stream — Accueil</title></head>
<body>
  <header><a href="/register">S'inscrire</a></header>
  <main><h1>Senpai-Stream</h1><a href="/play-episode/1399/1-1">Épisode 1</a></main>
</body>
</html>`;

export function createMockServer({ host = '127.0.0.1', port = 0 } = {}) {
  const openedTokens = new Set();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (reqUrl.pathname === '/' || reqUrl.pathname.startsWith('/watch')) {
      const scenario = reqUrl.searchParams.get('scenario');
      if (scenario === 'no_gate') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HOME_HTML);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (reqUrl.pathname === '/mock-site.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(MOCK_JS);
      return;
    }

    if (reqUrl.pathname.startsWith('/go/')) {
      const passId = reqUrl.searchParams.get('passId') || '5203269';
      const stepPart = reqUrl.pathname.split('/go/')[1] || 'step-1';
      openedTokens.add(`${passId}:${stepPart}`);
      const stepNum = stepPart.replace(/\D+/g, '') || '1';
      res.writeHead(302, { Location: `/ad.html?step=${stepNum}` });
      res.end();
      return;
    }

    if (reqUrl.pathname === '/ad.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(AD_HTML);
      return;
    }

    if (reqUrl.pathname === '/api/ad-clicked' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'bad_request' }));
          return;
        }

        const { passId, step, scenario, vuMs, tooFastTriggeredOnce } = payload;

        if (scenario === 'network_error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'server_error' }));
          return;
        }

        if (scenario === 'stuck') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'not_opened', message: 'Publicité non validée (test blocage).' }));
          return;
        }

        if (scenario === 'expired' && Number(step) >= 2) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'page_expiree' }));
          return;
        }

        if (scenario === 'too_fast' && Number(step) === 1 && !tooFastTriggeredOnce) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'too_fast', wait: 2 }));
          return;
        }

        const tokenKey = `${passId}:step-${step}`;
        if (!openedTokens.has(tokenKey)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'not_opened', message: 'Lien /go non ouvert.' }));
          return;
        }

        if (Number(vuMs) < 900) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: 'too_fast', wait: 1 }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, done: Number(step) }));
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return {
    server,
    start: () =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ host, port: addr.port, origin: `http://${host}:${addr.port}` });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    reset: () => openedTokens.clear()
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s1 = createMockServer({ host: '127.0.0.1', port: 4173 });
  const s2 = createMockServer({ host: 'localhost', port: 4174 });
  Promise.all([s1.start(), s2.start()]).then(([a, b]) => {
    console.log(`Mock Senpai Stream primary:   ${a.origin}/watch`);
    console.log(`Mock Senpai Stream mirror:    ${b.origin}/watch`);
  });
}
