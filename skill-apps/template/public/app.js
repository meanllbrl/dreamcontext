// The page's own code. A file, not an inline <script>: the backend's CSP (server.mjs) refuses inline script.
import { dc } from '/__dc/sdk.js';
const out = document.getElementById('out');
document.getElementById('hello').addEventListener('click', async () => {
  const r = await fetch('/api/hello');
  out.textContent = JSON.stringify(await r.json(), null, 2);
});
// The page reads dreamcontext data directly (insights, tasks, roadmap, the team list).
dc.tasks.list().then((t) => { out.textContent = `${Array.isArray(t) ? t.length : (t.tasks || []).length} tasks in this project`; }).catch(() => {});
