// A dreamcontext App backend, zero dependencies. Keep the three rules:
//   1. listen on process.env.PORT at process.env.HOST (127.0.0.1);
//   2. refuse anything without the gateway secret (dcGuard);
//   3. keep data in process.env.DC_DATA_DIR, secrets in .env (never committed).
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dc } from './lib/dc.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.DC_DATA_DIR || join(ROOT, 'data');
const SECRET = process.env.DC_GATEWAY_SECRET || '';

/** Only the dreamcontext gateway knows the secret: nothing else on this Mac reaches the app. */
function dcGuard(req) {
  return SECRET !== '' && req.headers['x-dc-gateway-secret'] === SECRET;
}

/** Escape text before it goes into HTML. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' http://127.0.0.1:*";

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf-8');
  return text ? JSON.parse(text) : {};
}

const routes = {
  // dc.health() tells dreamcontext which actions this backend serves (dc.actions below):
  // a tool in the manifest with no route here shows as drift on the app card.
  'GET /health': async (_req, res) => json(res, 200, dc.health()),
  'GET /api/hello': async (_req, res) => {
    await mkdir(DATA, { recursive: true });
    const file = join(DATA, 'visits.json');
    let n = 0;
    try { n = JSON.parse(await readFile(file, 'utf-8')).n; } catch { /* first visit */ }
    await writeFile(file, JSON.stringify({ n: n + 1 }));
    json(res, 200, { hello: 'from the backend', visits: n + 1 });
  },
  'POST /api/note': async (req, res) => {
    const body = await readBody(req);
    await dc.notify({ body: `Note: ${String(body.text ?? '').slice(0, 200)}` });
    json(res, 200, { ok: true });
  },
};

// Every manifest action this backend serves, by id. Add the id when you add the route.
dc.actions(['hello']);

const server = http.createServer(async (req, res) => {
  if (!dcGuard(req)) { res.writeHead(401); res.end('unauthorized'); return; }
  const url = new URL(req.url, 'http://app');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) { await route(req, res); return; }
    // Static files from public/ (no directory escape).
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) { res.writeHead(404); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch (err) {
    if (err && err.code === 'ENOENT') { res.writeHead(404); res.end('not found'); return; }
    console.error(err);
    json(res, 500, { error: 'internal' });
  }
});

server.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
