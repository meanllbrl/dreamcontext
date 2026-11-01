// A tiny app backend for the dreamcontext Apps tests. Behaviour is chosen by env:
//   BIND_ALL=1   listen on 0.0.0.0 (the supervisor must refuse it)
//   UNGUARDED=1  answer /health without checking the gateway secret
//   EXIT_EARLY=1 exit before listening
import http from 'node:http';
if (process.env.EXIT_EARLY) process.exit(3);
const secret = process.env.DC_GATEWAY_SECRET;
const guard = (req) => process.env.UNGUARDED || req.headers['x-dc-gateway-secret'] === secret;
const server = http.createServer((req, res) => {
  if (!guard(req)) { res.writeHead(401); res.end('no'); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/; HttpOnly' });
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
    return;
  }
  if (url.pathname === '/leak') {
    console.log(`token is ${process.env.DC_TOKEN} and Bearer ${process.env.API_KEY_FOR_TEST}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: process.env.DC_TOKEN, next: `https://graph.example/x?access_token=${process.env.API_KEY_FOR_TEST}&after=2` }));
    return;
  }
  if (url.pathname === '/slow') { setTimeout(() => { res.writeHead(200); res.end('slow done'); }, Number(url.searchParams.get('ms') || 100)); return; }
  if (url.pathname === '/env') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(process.env)); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>echo</title><h1>echo app</h1>');
});
// A WebSocket-shaped upgrade: answers 101 and echoes what it was sent (enough to prove the pipe).
server.on('upgrade', (req, sock) => {
  if (!guard(req)) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Saw-Origin: ${req.headers.origin ?? ''}\r\nX-Saw-Secret: ${req.headers['x-dc-gateway-secret'] === secret ? 'yes' : 'no'}\r\n\r\n`);
  sock.on('data', (d) => sock.write(d));
});
server.listen(Number(process.env.PORT), process.env.BIND_ALL ? '0.0.0.0' : process.env.HOST);
