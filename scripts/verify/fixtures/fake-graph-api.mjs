#!/usr/bin/env node
// A fictional Meta Graph API for the dreamcontext Apps Meta example (never the real one).
//   GET  /v21.0/act_<id>/campaigns?access_token=…&after=…   two pages, paging.next carries the token
//   POST /v21.0/<campaign id>  {status: PAUSED|ACTIVE}       Bearer or ?access_token
// Usage: node fake-graph-api.mjs [--port N] [--token T]; prints {"port": N}.
import http from 'node:http';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TOKEN = opt('token', 'EAAB-fixture-token-0123456789');
const campaigns = [
  { id: '1201', name: 'Kış İndirimi', status: 'ACTIVE', spend: '412.50' },
  { id: '1202', name: 'Yeni Üyeler', status: 'ACTIVE', spend: '98.10' },
  { id: '1203', name: 'Retargeting', status: 'PAUSED', spend: '0.00' },
];
export function startGraph(port = 0, token = TOKEN) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://graph');
    const auth = url.searchParams.get('access_token') || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (auth !== token) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } })); return; }
    const list = /^\/v21\.0\/act_[0-9]+\/campaigns$/.exec(url.pathname);
    if (list && req.method === 'GET') {
      const after = url.searchParams.get('after');
      const page = after === 'p2' ? campaigns.slice(2) : campaigns.slice(0, 2);
      const body = { data: page };
      if (!after) body.paging = { next: `http://127.0.0.1:${server.address().port}${url.pathname}?access_token=${token}&after=p2` };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    const one = /^\/v21\.0\/([0-9]+)$/.exec(url.pathname);
    if (one && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const c = campaigns.find((x) => x.id === one[1]);
        const status = JSON.parse(raw || '{}').status;
        if (!c || !['PAUSED', 'ACTIVE'].includes(status)) { res.writeHead(400); res.end('{}'); return; }
        c.status = status;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startGraph(Number(opt('port', '0')));
  console.log(JSON.stringify({ port: s.address().port }));
}
