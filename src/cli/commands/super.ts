import { Command } from 'commander';
import { request } from 'node:http';
import { windowEnv } from './window.js';

/**
 * `dreamcontext super …` — the project's Super Agent drives the hand-over screen: its child
 * chats (delegate, brief, read, answer, send), the cards floating around it (open, shape, half,
 * present, stack, float, close), the one question queue, and its children's worktrees.
 *
 * A THIN HTTP CLIENT, the `window` command's shape: every verb is one call to
 * `/api/super/v/<verb>` with the window token the server injects into every project chat.
 * The SERVER decides who may call: only the vault's recorded super session, running in Super
 * Agent mode (src/server/routes/super.ts). From any other chat, a terminal or a `claude -p`
 * it refuses.
 */

export const NOT_THE_SUPER_AGENT = '`dreamcontext super` works only from the project\'s Super Agent chat';

interface CallResult { status: number; body: Record<string, unknown> }

export function callSuper(verb: string, body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<CallResult> {
  const e = windowEnv(env);
  if (!e) return Promise.resolve({ status: 401, body: { error: 'not_a_chat', message: NOT_THE_SUPER_AGENT } });
  const url = new URL(`/api/super/v/${verb}`, e.url);
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

const run = (verb: string, body: Record<string, unknown>) => callSuper(verb, body).then(print);
const usage = (message: string) => print({ status: 400, body: { error: 'invalid_args', message } });

const KINDS = 'chat | insight | task | knowledge | whiteboard | board | web | image';

export function registerSuperCommand(program: Command): void {
  const s = program
    .command('super')
    .description('The project\'s Super Agent: delegate to child chats, arrange their cards, answer the queue (only from the Super Agent chat)');

  s.command('state')
    .description('Children (status, brief, last line, elapsed, worktree/branch), cards and view, queue and machine facts')
    .action(() => run('state', {}));

  s.command('delegate')
    .description('Start a child chat in THIS project and open its card; returns its session id')
    .requiredOption('--prompt <text>', 'The child\'s first message, complete and self-contained')
    .option('--brief <line>', 'The one-line reminder its card shows')
    .option('--mode <mode>', 'basic | plan | develop', 'basic')
    .option('--model <id>', 'Model id or alias')
    .option('--effort <level>', 'low | medium | high | xhigh | max')
    .option('--worktree <repo>', 'Give it its own worktree of this linked repo, on branch super/<slug>')
    .option('--slug <slug>', 'The worktree and branch name (a-z, 0-9, -)')
    .option('--base <ref>', 'The commit the worktree starts from (default: the repo\'s HEAD)')
    .action((o: { prompt: string; brief?: string; mode: string; model?: string; effort?: string; worktree?: string; slug?: string; base?: string }) =>
      run('delegate', { prompt: o.prompt, brief: o.brief, mode: o.mode, model: o.model, effort: o.effort, worktree: o.worktree, slug: o.slug, base: o.base }));

  s.command('open <kind> <ref>')
    .description(`Open a floating card: ${KINDS}. ref = a session id, a slug, a URL or a project path`)
    .option('--shape <shape>', 'square (1:1) | tall (3:4); default: tall for chat and web, square for the rest')
    .option('--title <text>', 'Its label')
    .action((kind: string, ref: string, o: { shape?: string; title?: string }) =>
      run('open', { kind, ref, shape: o.shape, title: o.title }));

  s.command('shape <card> <shape>')
    .description('Make a card square (1:1) or tall (3:4)')
    .action((container: string, shape: string) => run('shape', { container, shape }));

  s.command('half [card]')
    .description('Show one card side by side with you (half page); --off returns to the floating cards')
    .option('--off', 'Back to the floating cards')
    .action((container: string | undefined, o: { off?: boolean }) => {
      if (!o.off && !container) return usage('name a card, or pass --off');
      return run('half', { container: o.off ? null : container });
    });

  s.command('present [cards...]')
    .description('Presentation: you move left, 1-4 cards fill the right; --off returns to the floating cards')
    .option('--off', 'Leave the presentation')
    .action((containers: string[], o: { off?: boolean }) => {
      if (!o.off && containers.length === 0) return usage('name 1-4 cards, or pass --off');
      return run('present', { containers: o.off ? [] : containers });
    });

  s.command('stack <card>')
    .description('Put a card in the Others stack (bottom right)')
    .action((container: string) => run('stack', { container }));

  s.command('float <card>')
    .description('Bring a card from Others back to the floating cards (placed for you)')
    .action((container: string) => run('float', { container }));

  s.command('close <card>')
    .description('Close a card (a child chat keeps running)')
    .action((container: string) => run('close', { container }));

  s.command('brief <child> <line>')
    .description('Set the one-line reminder a child\'s card shows')
    .action((child: string, line: string) => run('brief', { child, line }));

  s.command('read <child>')
    .description('The end of a child\'s transcript (bounded), fenced as the child\'s text')
    .option('--bytes <n>', 'How much of the end to read (max 262144)')
    .action((child: string, o: { bytes?: string }) => run('read', { child, bytes: o.bytes ? Number(o.bytes) : undefined }));

  s.command('answer <child> <requestId> [choice...]')
    .description('Answer a child\'s QUESTION (never a permission) with its option label(s) or --text')
    .option('--text <text>', 'A free-text answer instead of an option')
    .action((child: string, requestId: string, choice: string[], o: { text?: string }) =>
      run('answer', { child, requestId, choices: choice, text: o.text }));

  s.command('send <child> <text>')
    .description('Send a message into a child chat (queued if it is busy)')
    .action((child: string, text: string) => run('send', { child, text }));

  const q = s.command('queue').description('The one question queue');
  q.command('list')
    .description('Every queue item: what it is, whose, its state')
    .action(() => run('queue-list', {}));
  q.command('ask <item> <text>')
    .description('Escalate a question to the owner with your words (never a permission)')
    .action((item: string, text: string) => run('queue-ask', { item, text }));
  q.command('done <item>')
    .description('Mark an item handled (never a permission)')
    .action((item: string) => run('queue-done', { item }));

  s.command('merge <children...>')
    .description('Merge children\'s super/* branches into super/<topic> in its own worktree (never the default branch, never pushed)')
    .requiredOption('--into <topic>', 'The integration branch name (a-z, 0-9, -)')
    .action((children: string[], o: { into: string }) => run('merge', { children, into: o.into }));

  const w = s.command('worktree').description('Your children\'s worktrees');
  w.command('list')
    .description('Each child\'s worktree, branch, dirty or clean, merged or not')
    .action(() => run('worktree-list', {}));
  w.command('remove <child>')
    .description('Remove a child\'s worktree; refuses one that is dirty or unmerged')
    .action((child: string) => run('worktree-remove', { child }));
}
