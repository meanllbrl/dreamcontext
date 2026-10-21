import { Command } from 'commander';
import { request } from 'node:http';
import { windowEnv } from './window.js';

/**
 * `dreamcontext super …` — the project's Super Agent drives the hand-over screen: its child
 * chats (delegate, brief, read, answer, send, end, resume, update, adopt), the cards floating around it (open, half, present,
 * stack, float, close, group, ungroup), the one question queue, and its children's worktrees.
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
    .description('Children (each with its live status: working | idle | asking | ended | parked | gone; brief, last line, elapsed, worktree/branch), cards and view, queue and machine facts')
    .action(() => run('state', {}));

  const job = (c: Command): Command => c
    .option('--brief <line>', 'The one-line reminder its row and card show')
    .option('--mode <mode>', 'basic | plan | develop', 'basic')
    .option('--model <id>', 'Model id or alias')
    .option('--effort <level>', 'low | medium | high | xhigh | max')
    .option('--worktree <repo>', 'Give it its own worktree of this linked repo, on branch super/<slug>')
    .option('--slug <slug>', 'The worktree and branch name (a-z, 0-9, -)')
    .option('--base <ref>', 'The commit the worktree starts from (default: the repo\'s HEAD)')
    .option('--task <slug>', 'Link its row to this task (state/<slug>.md)');
  type JobOpts = { prompt?: string; brief?: string; mode: string; model?: string; effort?: string; worktree?: string; slug?: string; base?: string; task?: string };
  const jobBody = (o: JobOpts) => ({ prompt: o.prompt, brief: o.brief, mode: o.mode, model: o.model, effort: o.effort, worktree: o.worktree, slug: o.slug, base: o.base, task: o.task });

  job(s.command('delegate')
    .description('Start a child chat in THIS project and open its card; returns its session id. At the cap the job is kept in the pool')
    .option('--prompt <text>', 'The child\'s first message, complete and self-contained')
    .option('--from <pool id>', 'Start a job the pool kept (`super pool list`), exactly as it was kept')
    .option('--force', 'With --from: start a job whose earlier start went unconfirmed')
    .option('--succeeds <child>', 'It takes this child\'s work over (a context handoff): the card, brief and task pass to it, and the old child is ended (told to stop first if busy)'))
    .action((o: JobOpts & { from?: string; force?: boolean; succeeds?: string }) => {
      if (o.from) return run('delegate', { from: o.from, force: o.force === true, succeeds: o.succeeds });
      if (!o.prompt) return usage('give --prompt, or --from <pool id>');
      return run('delegate', { ...jobBody(o), succeeds: o.succeeds });
    });

  s.command('open <kind> <ref>')
    .description(`Open a floating card: ${KINDS}. ref = a session id, a slug, a URL or a project path`)
    .option('--shape <shape>', 'square | tall: recorded only; every floating card is a 1:1 tile')
    .option('--title <text>', 'Its label')
    .action((kind: string, ref: string, o: { shape?: string; title?: string }) =>
      run('open', { kind, ref, shape: o.shape, title: o.title }));

  s.command('shape <card> <shape>')
    .description('Record a card\'s shape (square | tall); kept for older scripts: every floating card is drawn as a 1:1 tile')
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
    .description('Put a card or a group in Others (bottom right); a grouped card leaves its group')
    .action((container: string) => run('stack', { container }));

  s.command('float <card>')
    .description('Bring a card or a group from Others back to the stage (placed for you); a grouped card leaves its group')
    .action((container: string) => run('float', { container }));

  s.command('close <card>')
    .description('Close a card (a child chat keeps running; `super end` ends it)')
    .action((container: string) => run('close', { container }));

  s.command('group <cards...>')
    .description('Put cards together as one tile on the stage; a group id among them adds the rest to that group')
    .option('--name <name>', 'Name the group (or rename it: `super group <group> --name <name>`)')
    .action((cards: string[], o: { name?: string }) => run('group', { containers: cards, name: o.name }));

  s.command('ungroup <targets...>')
    .description('Dissolve a group (its cards take its place on the stage or in Others), or take cards out of their group (they float)')
    .action((targets: string[]) => run('ungroup', { targets }));

  s.command('brief <child> <line>')
    .description('Set the job row\'s line (doing / next) its card shows too')
    .option('--task <slug>', 'Link the row to this task (state/<slug>.md)')
    .action((child: string, line: string, o: { task?: string }) => run('brief', { child, line, task: o.task }));

  s.command('read <child>')
    .description('A child\'s last reply, whole (tool calls skipped), fenced as the child\'s text')
    .option('--bytes <n>', 'Instead: the raw end of its transcript, this many bytes (max 262144)')
    .action((child: string, o: { bytes?: string }) => run('read', { child, bytes: o.bytes ? Number(o.bytes) : undefined }));

  s.command('answer <child> <requestId> [choice...]')
    .description('Answer a child\'s QUESTION (never a permission) with its option label(s) or --text')
    .option('--text <text>', 'A free-text answer instead of an option')
    .action((child: string, requestId: string, choice: string[], o: { text?: string }) =>
      run('answer', { child, requestId, choices: choice, text: o.text }));

  s.command('end [children...]')
    .description('End idle children for good: the process exits, the tab and card go, the transcript stays (`super resume` reopens it). Refused while one works, asks or runs background tasks')
    .option('--idle', 'List the idle children you started; add --yes to end them all')
    .option('--yes', 'With --idle: end every listed child')
    .option('--force', 'ONLY when the owner asked: end it even while it works, asks or runs background tasks, or when it is his own chat')
    .action((children: string[], o: { idle?: boolean; yes?: boolean; force?: boolean }) => {
      if (!o.idle && children.length === 0) return usage('name the children to end, or pass --idle');
      return run('end', o.idle ? { idle: true, yes: o.yes === true } : { children, force: o.force === true });
    });

  s.command('resume <child>')
    .description('Reopen an ended or parked child: the same conversation, as a child again (its card comes back); it starts in the mode, model and effort it had unless you name others')
    .option('--mode <mode>', 'basic | plan | develop')
    .option('--model <id>', 'Model id or alias')
    .option('--effort <level>', 'low | medium | high | xhigh | max')
    .option('--force', 'ONLY when the owner asked: reopen his own (adopted) chat')
    .action((child: string, o: { mode?: string; model?: string; effort?: string; force?: boolean }) =>
      run('resume', { child, mode: o.mode, model: o.model, effort: o.effort, force: o.force === true }));

  s.command('update <child>')
    .description('Change a RUNNING child\'s mode, model or effort (the window\'s own switches; a mode change restarts it on the same conversation once its turn ends); recorded for `super resume`')
    .option('--mode <mode>', 'basic | plan | develop')
    .option('--model <id>', 'Model id or alias (from its next turn)')
    .option('--effort <level>', 'low | medium | high | xhigh | max')
    .option('--force', 'ONLY when the owner asked: change his own (adopted) chat')
    .action((child: string, o: { mode?: string; model?: string; effort?: string; force?: boolean }) => {
      if (!o.mode && !o.model && !o.effort) return usage('name what changes: --mode, --model or --effort');
      return run('update', { child, mode: o.mode, model: o.model, effort: o.effort, force: o.force === true });
    });

  s.command('adopt <chat>')
    .description('Make an open chat of this project one of your children (its card comes, it hears of the hand-over). Every chat you did not start is the owner\'s: only on his word, with --force')
    .option('--brief <line>', 'The one-line reminder its card shows (default: its title)')
    .option('--force', 'ONLY when the owner asked: adopt his own chat')
    .action((chat: string, o: { brief?: string; force?: boolean }) =>
      run('adopt', { chat, brief: o.brief, force: o.force === true }));

  s.command('send <child> <text>')
    .description('Send a message into a child chat (steered into its running turn; queued only while it asks)')
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

  const p = s.command('pool').description('Jobs kept for later (the job list\'s Havuz)');
  job(p.command('add')
    .description('Keep a job for later; start it with `delegate --from <id>` when a slot frees')
    .requiredOption('--prompt <text>', 'The job\'s first message, complete and self-contained (at most 16 KB)')
    .option('--note <line>', 'Your note on its row'))
    .action((o: JobOpts & { note?: string }) => run('pool-add', { ...jobBody(o), note: o.note }));
  p.command('remove <id>')
    .description('Drop a job from the pool')
    .action((id: string) => run('pool-remove', { id }));
  p.command('list')
    .description('The pooled jobs (title, note, task, held, maybe started)')
    .action(() => run('pool-list', {}));

  s.command('ask <text>')
    .description('Ask the owner YOUR own question (one at a time); its answer is his next message to you')
    .option('--options <a|b>', 'Up to 4 short answers (each at most 24 characters), separated by |')
    .action((text: string, o: { options?: string }) =>
      run('ask', { text, ...(o.options ? { options: o.options.split('|').map((x) => x.trim()) } : {}) }));

  s.command('merge <children...>')
    .description('Merge children\'s super/* branches into super/<topic> in its own worktree (never the default branch, never pushed)')
    .requiredOption('--into <topic>', 'The integration branch name (a-z, 0-9, -)')
    .action((children: string[], o: { into: string }) => run('merge', { children, into: o.into }));

  s.command('clean')
    .description('Give disk back: remove ended children\'s worktrees that are merged and clean (branches kept) and this repo\'s own test temp folders older than a day. Chrome and system files are never touched')
    .option('--dry-run', 'Only list what would go, with sizes')
    .action((o: { dryRun?: boolean }) => run('clean', { dryRun: o.dryRun === true }));

  const w = s.command('worktree').description('Your children\'s worktrees');
  w.command('list')
    .description('Each child\'s worktree, branch, dirty or clean, merged or not')
    .action(() => run('worktree-list', {}));
  w.command('remove <child>')
    .description('Remove a child\'s worktree; refuses one that is dirty or unmerged')
    .action((child: string) => run('worktree-remove', { child }));
}
