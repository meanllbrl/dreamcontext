import { Command } from 'commander';
import { request } from 'node:http';

/**
 * `dreamcontext assistant …` — the dreamcontext Assistant's own verbs.
 *
 * A THIN HTTP CLIENT. Every verb is one call to `/api/assistant/*` on the running desktop
 * server, authenticated by the two env vars the server injects into the `__assistant__`
 * chat's spawn ONLY (`DREAMCONTEXT_ASSISTANT_URL`, `DREAMCONTEXT_ASSISTANT_TOKEN`). Run from
 * anywhere else — a terminal, another project's agent — it refuses with the same named error
 * the server would give.
 *
 * `node:http`, not `fetch`: a gated verb (`send`, `answer`, `broadcast`) BLOCKS until the
 * owner approves it in the notch, up to ten minutes, and undici's fetch gives up waiting for
 * response headers after five.
 *
 * Distinct from `dreamcontext app` (install/update/status of the desktop bundle), which this
 * namespace never touches.
 */

export const NOT_ASSISTANT = 'only the dreamcontext Assistant can drive the app';

interface CallResult { status: number; body: Record<string, unknown> }

export function assistantEnv(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  const url = env.DREAMCONTEXT_ASSISTANT_URL;
  const token = env.DREAMCONTEXT_ASSISTANT_TOKEN;
  if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return null;
  return { url, token };
}

export function callAssistant(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CallResult> {
  const e = assistantEnv(env);
  if (!e) return Promise.resolve({ status: 401, body: { error: 'not_assistant', message: NOT_ASSISTANT } });
  const url = new URL(path, e.url);
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve) => {
    const req = request(url, {
      method,
      headers: {
        'x-dreamcontext-assistant-token': e.token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { parsed = { message: data }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: 'unreachable', message: `the app is not reachable: ${err.message}` } }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Print the server's answer. JSON is the contract — the assistant reads it. A refusal exits 1
 *  with the server's own message on stderr, so the assistant can say it verbatim. */
function print(r: CallResult): void {
  if (r.status >= 400 || r.status === 0 || r.body.ok === false) {
    const msg = typeof r.body.message === 'string' ? r.body.message : typeof r.body.error === 'string' ? r.body.error : `HTTP ${r.status}`;
    process.stderr.write(`${JSON.stringify(r.body, null, 2)}\n`);
    if (msg && r.body.message) process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(r.body, null, 2)}\n`);
}

const ui = (verb: string, body: Record<string, unknown>) => callAssistant('POST', `/api/assistant/ui/${verb}`, body).then(print);

export function registerAssistantCommand(program: Command): void {
  const a = program
    .command('assistant')
    .description('The dreamcontext Assistant\'s verbs — only its own chat session can run these');

  a.command('projects')
    .description('Every registered project: what it is, what is active, live chats')
    .action(async () => print(await callAssistant('GET', '/api/assistant/projects')));

  a.command('sessions')
    .description('Live chats across every project, with status starting|working|asking|idle|gone')
    .option('--vault <vault>', 'Only this project')
    .option('--status <status>', 'Only chats in this status')
    .action(async (o: { vault?: string; status?: string }) => {
      const p = new URLSearchParams();
      if (o.vault) p.set('project', o.vault);
      if (o.status) p.set('status', o.status);
      print(await callAssistant('GET', `/api/assistant/sessions${p.size ? `?${p}` : ''}`));
    });

  a.command('watch <sessionId>')
    .description('Wait until a chat is idle / asking / changes; returns at once if it has ended')
    .option('--until <status>', 'idle | asking | any', 'idle')
    .option('--timeout <seconds>', 'Give up after this many seconds', '590')
    .action(async (sessionId: string, o: { until: string; timeout: string }) => {
      const p = new URLSearchParams({ session: sessionId, until: o.until, timeout: o.timeout });
      print(await callAssistant('GET', `/api/assistant/watch?${p}`));
    });

  a.command('broadcast <message>')
    .description('Send the owner\'s message to every project; each project\'s own agent writes it')
    .option('--to <vaults>', 'Comma-separated project names (default: all)')
    .option('--timeout <seconds>', 'Per-project timeout')
    .action(async (message: string, o: { to?: string; timeout?: string }) => {
      print(await callAssistant('POST', '/api/assistant/broadcast', {
        message,
        ...(o.to ? { to: o.to.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(o.timeout ? { timeoutSec: Number(o.timeout) } : {}),
      }));
    });

  a.command('open <vault>')
    .description('Open a project window (or bring its window forward)')
    .option('--page <route>', 'Page inside the project: tasks/<slug>, knowledge/<slug> or core/<slug>')
    .option('--new-window', 'Always in its own window')
    .action((vault: string, o: { page?: string; newWindow?: boolean }) => ui('open', { vault, page: o.page, newWindow: !!o.newWindow }));

  a.command('chat <vault>')
    .description('Start a chat in a project and send the prompt')
    .requiredOption('--prompt <text>', 'What to send')
    .option('--mode <mode>', 'basic | plan | develop', 'basic')
    .action((vault: string, o: { prompt: string; mode: string }) => ui('chat', { vault, prompt: o.prompt, mode: o.mode }));

  a.command('send <sessionId> <text>')
    .description('Send a follow-up into a live chat')
    .action((sessionId: string, text: string) => ui('send', { sessionId, text }));

  a.command('answer <sessionId>')
    .description('Answer a chat\'s pending question or permission prompt')
    .requiredOption('--question <id>', 'The pending question id (from sessions/watch)')
    .option('--choice <label>', 'One of the offered options')
    .option('--text <text>', 'A free-text answer')
    .action((sessionId: string, o: { question: string; choice?: string; text?: string }) =>
      ui('answer', { sessionId, question: o.question, choice: o.choice, text: o.text }));

  a.command('focus <vault>')
    .description('Bring a project\'s window to the front')
    .action((vault: string) => ui('focus', { vault }));

  a.command('tile <vaults...>')
    .description('Place project windows side by side on the current monitor')
    .option('--layout <layout>', 'columns | rows | grid', 'columns')
    .action((vaults: string[], o: { layout: string }) => ui('tile', { vaults, layout: o.layout }));

  a.command('notify <text>')
    .description('Show a notice in the notch')
    .option('--level <level>', 'info | attention', 'info')
    .action((text: string, o: { level: string }) => ui('notify', { text, level: o.level }));
}
