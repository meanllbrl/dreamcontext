import { Command } from 'commander';
import { request } from 'node:http';

/**
 * `dreamcontext window …` — an agent drives the dreamcontext chat surface it is drawn in:
 * read the layout, open a chat (as a tab or side by side), split or join tabs, switch a
 * tab's mode, model or effort, send to another tab, focus or close one.
 *
 * A THIN HTTP CLIENT, the `assistant` command's shape: every verb is one call to
 * `/api/window/<verb>`, authenticated by the two env vars the server injects into every
 * project chat's spawn (`DREAMCONTEXT_WINDOW_URL`, `DREAMCONTEXT_WINDOW_TOKEN`). The token
 * names THAT chat's socket, so the verb lands in the window showing the chat that ran it.
 * From a terminal or a `claude -p` it refuses: there is no window to drive.
 *
 * `--tab` takes a tab id from `window state` (a chat's conversation id); omitted, the verb
 * acts on the calling chat itself.
 */

export const NOT_A_CHAT = 'window control works only from an agent running in a dreamcontext chat tab';

interface CallResult { status: number; body: Record<string, unknown> }

export function windowEnv(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  const url = env.DREAMCONTEXT_WINDOW_URL;
  const token = env.DREAMCONTEXT_WINDOW_TOKEN;
  if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return null;
  return { url, token };
}

export function callWindow(verb: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<CallResult> {
  const e = windowEnv(env);
  if (!e) return Promise.resolve({ status: 401, body: { error: 'not_a_chat', message: NOT_A_CHAT } });
  const url = new URL(`/api/window/${verb}`, e.url);
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'x-dreamcontext-window-token': e.token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

/** JSON is the contract. A refusal exits 1 with the reason on stderr. */
function print(r: CallResult): void {
  if (r.status >= 400 || r.status === 0 || r.body.ok === false) {
    process.stderr.write(`${JSON.stringify(r.body, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(r.body.result ?? r.body, null, 2)}\n`);
}

const run = (verb: string, body: Record<string, unknown>) => callWindow(verb, body).then(print);

export function registerWindowCommand(program: Command): void {
  const w = program
    .command('window')
    .description('Drive the chat window this agent is drawn in: tabs, splits, mode, model (only from a dreamcontext chat)');

  w.command('state')
    .description('The window\'s panes and tabs: id, title, kind, mode, model, busy, which one is you')
    .action(() => run('state', {}));

  w.command('new')
    .description('Open a new chat as a tab of the focused pane, or beside it with --split')
    .option('--prompt <text>', 'First message to send')
    .option('--mode <mode>', 'basic | plan | develop', 'basic')
    .option('--model <id>', 'Model id or alias (e.g. opus, sonnet, claude-opus-5-5)')
    .option('--effort <level>', 'low | medium | high | xhigh | max')
    .option('--split', 'Open it in a new pane beside the focused one (side by side)')
    .option('--terminal', 'A terminal tab instead of a chat')
    .action((o: { prompt?: string; mode: string; model?: string; effort?: string; split?: boolean; terminal?: boolean }) =>
      run('new', { prompt: o.prompt ?? '', mode: o.mode, model: o.model, effort: o.effort, split: !!o.split, terminal: !!o.terminal }));

  w.command('split')
    .description('Move a tab into its own pane beside its current one (default: this chat)')
    .option('--tab <id>', 'The tab to move')
    .action((o: { tab?: string }) => run('split', { tab: o.tab }));

  w.command('join')
    .description('Move a tab into another tab\'s pane, undoing a split (default: this chat)')
    .requiredOption('--into <id>', 'A tab in the pane to join')
    .option('--tab <id>', 'The tab to move')
    .action((o: { tab?: string; into: string }) => run('join', { tab: o.tab, into: o.into }));

  w.command('focus <tab>')
    .description('Bring a tab to the front of its pane and focus it')
    .action((tab: string) => run('focus', { tab }));

  w.command('mode <mode>')
    .description('Switch a chat\'s mode: basic | plan | develop. Restarts that chat on the same conversation; for this chat it waits until the turn ends')
    .option('--tab <id>', 'The chat to switch')
    .action((mode: string, o: { tab?: string }) => run('mode', { tab: o.tab, mode }));

  w.command('model <id>')
    .description('Switch a chat\'s model live; it applies from the next turn')
    .option('--tab <id>', 'The chat to switch')
    .action((model: string, o: { tab?: string }) => run('model', { tab: o.tab, model }));

  w.command('effort <level>')
    .description('Switch a chat\'s effort live: low | medium | high | xhigh | max')
    .option('--tab <id>', 'The chat to switch')
    .action((level: string, o: { tab?: string }) => run('effort', { tab: o.tab, level }));

  w.command('send <tab> <text>')
    .description('Send a message into another chat tab (steered into its running turn; queued only while it asks)')
    .action((tab: string, text: string) => run('send', { tab, text }));

  w.command('close <tab>')
    .description('Close a tab; a working or asking chat needs --force')
    .option('--force', 'Close it even mid-turn — only when the owner asked')
    .action((tab: string, o: { force?: boolean }) => run('close', { tab, force: !!o.force }));
}
