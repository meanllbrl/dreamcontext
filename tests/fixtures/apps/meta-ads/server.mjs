// The Meta Ads example app (fictional account). Talks to the Graph API at GRAPH_URL with
// META_TOKEN from .env, keeps nothing secret in its answers, follows paging server-side.
import http from 'node:http';
const SECRET = process.env.DC_GATEWAY_SECRET || '';
const GRAPH = process.env.GRAPH_URL || 'https://graph.facebook.com';
const TOKEN = process.env.META_TOKEN || '';
const ACCOUNT = process.env.META_ACCOUNT || 'act_1000';
const guard = (req) => SECRET && req.headers['x-dc-gateway-secret'] === SECRET;
const json = (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
async function body(req) { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {}; }
async function graph(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${GRAPH}/v21.0${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `graph ${r.status}`);
  return data;
}
async function allCampaigns() {
  let page = await graph(`/${ACCOUNT}/campaigns?access_token=${encodeURIComponent(TOKEN)}`);
  const out = [...page.data];
  // A real paging.next carries the token: it is followed here and never returned.
  while (page.paging && page.paging.next) { page = await graph(page.paging.next); out.push(...page.data); }
  return out;
}
const server = http.createServer(async (req, res) => {
  if (!guard(req)) { res.writeHead(401); res.end(); return; }
  const url = new URL(req.url, 'http://app');
  try {
    if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (req.method === 'GET' && url.pathname === '/api/campaigns') { json(res, 200, { campaigns: await allCampaigns() }); return; }
    const m = /^\/api\/campaigns\/(pause|resume)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const { id } = await body(req);
      if (!/^[0-9]+$/.test(String(id))) { json(res, 400, { error: 'id must be a campaign id' }); return; }
      await graph(`/${id}`, { method: 'POST', body: JSON.stringify({ status: m[1] === 'pause' ? 'PAUSED' : 'ACTIVE' }) });
      json(res, 200, { ok: true, id, status: m[1] === 'pause' ? 'PAUSED' : 'ACTIVE' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/debug/raw') { json(res, 200, await graph(`/${ACCOUNT}/campaigns?access_token=${encodeURIComponent(TOKEN)}`)); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Meta Ads</title><h1>Meta Ads</h1><div id="list"></div><script type="module">const r=await fetch("/api/campaigns");const d=await r.json();document.getElementById("list").textContent=d.campaigns.map(c=>`${c.name}: ${c.status}`).join(" · ");</script>');
  } catch (err) {
    console.error(`graph error: ${err.message}`);
    json(res, 502, { error: String(err.message).slice(0, 200) });
  }
});
server.listen(Number(process.env.PORT), process.env.HOST || '127.0.0.1');
