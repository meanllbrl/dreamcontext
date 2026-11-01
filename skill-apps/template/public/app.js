// The page's own code. A file, not an inline <script>: the backend's CSP (server.mjs) refuses inline script.
import { dc } from '/__dc/sdk.js';
const out = document.getElementById('out');
const show = (line) => { out.textContent += `${line}\n`; };
fetch('/api/hello').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((j) => show(`backend: ${j.hello}`), (e) => show(`backend: ${e.message}`));
dc.tasks.list().then((t) => show(`tasks: ${Array.isArray(t) ? t.length : (t.tasks || []).length}`), (e) => show(`tasks: ${e.message}`));
