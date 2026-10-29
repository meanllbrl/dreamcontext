import { Command } from 'commander';
import { request } from 'node:http';
import { windowEnv } from './window.js';
import { MAX_LIVE_CHILDREN } from '../../lib/super/types.js';
import { ensureContextRoot } from '../../lib/context-path.js';
import { error, info, success } from '../../lib/format.js';
import { HANDOFF_FIELDS, contextHandoffGaps, formatGaps, type HandoffFields } from '../../lib/handoff-readiness.js';
import { handoffKey, writeHandoffRecord, type HandoffRecord } from '../../lib/context-watch.js';
import { superHandoffContext } from '../../lib/super/handoff-task.js';
import { buildAskBody, collectOption, showBody, type AskCliOpts } from '../../lib/super/ask-cli.js';
import { SUPER_HANDOFF_REL, SUPER_HANDOFF_TASK, renderSuperHandoffEntry, writeSuperHandoff } from '../../lib/super/handoff-file.js';
import { locateHandoffSession, writeHandoffArtifacts } from './handoff-artifacts.js';

/**
 * `dreamcontext super …` — the project's Super Agent drives the hand-over screen: its child
 * chats (delegate, brief, read, answer, send, end, resume, update, adopt), the cards floating around it (open, half, present,
 * stack, float, close, group, ungroup), the one question queue, its children's worktrees, and
 * jobs for the project's AI Team members (team ask).
 *
 * A THIN HTTP CLIENT, the `window` command's shape: every verb is one call to
 * `/api/super/v/<verb>` with the window token the server injects into every project chat.
 * The SERVER decides who may call: only the vault's recorded super session, running in Super
 * Agent mode (src/server/routes/super.ts). From any other chat, a terminal or a `claude -p`
 * it refuses.
 *
 * Anywhere a verb takes a <child>, the first 8 or more characters of its session id name it
 * (an ambiguous prefix is refused with the candidates).
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
  const result = (r.body.result ?? r.body) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  // The child runs but has no card: said on stderr too, so it cannot pass unseen. Exit 0: the
  // verb itself worked, and a retry would start the job twice.
  if (result && result.card === 'not_opened') {
    const e = (result.cardError ?? {}) as { message?: unknown; todo?: unknown };
    process.stderr.write(`CARD NOT OPENED: ${String(e.message ?? 'the owner cannot see this child')}. Next: ${String(e.todo ?? '`super state`')}\n`);
  }
}

const run = (verb: string, body: Record<string, unknown>) => callSuper(verb, body).then(print);

/** What each `super open` kind takes as its ref (2026-10-29: `board <whiteboard slug>` drew a dead card). */
export const OPEN_REF_HELP = [
  'ref per kind:',
  '  whiteboard  a slug from `dreamcontext whiteboard list` (a dreamcontext whiteboard: always this kind, never board)',
  '  board       a project .excalidraw.md file OUTSIDE _dream_context/whiteboards/, project-relative; it must exist',
  '  chat, browser  one of your children\'s session ids',
  '  team        an AI Team job id (`super state`)',
  '  task, knowledge, insight  its slug',
  '  web         an https URL, a dev server on localhost, or a project file',
  '  image, pdf, video  a project-relative file path',
  '  agenda      no ref: brings back the owner\'s agenda card (Waiting on you, Now, Done, Up next)',
].join('\n');
const usage = (message: string) => print({ status: 400, body: { error: 'invalid_args', message } });

const KINDS = 'chat | insight | task | knowledge | whiteboard | board | web | image | pdf | video | browser | team | agenda';

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
    .option('--task <slug>', 'Link its row to this task (state/<slug>.md)')
    .option('--mcp <names>', 'The MCP servers it may use, comma-separated (`super state` lists them); a child gets none of the others');
  type JobOpts = { prompt?: string; brief?: string; mode: string; model?: string; effort?: string; worktree?: string; slug?: string; base?: string; task?: string; mcp?: string };
  const jobBody = (o: JobOpts) => ({ prompt: o.prompt, brief: o.brief, mode: o.mode, model: o.model, effort: o.effort, worktree: o.worktree, slug: o.slug, base: o.base, task: o.task, mcp: o.mcp });

  job(s.command('delegate')
    .description(`Start a child chat in THIS project and open its card; returns its session id. At the cap (${MAX_LIVE_CHILDREN} live children, the only limit), the job is kept in the pool (\`held\`)`)
    .option('--prompt <text>', 'The child\'s first message, complete and self-contained')
    .option('--from <pool id>', 'Start a job the pool kept (`super pool list`), exactly as it was kept')
    .option('--force', 'With --from: start a job whose earlier start went unconfirmed')
    .option('--succeeds <child>', 'It takes this child\'s work over (a context handoff): the card, brief and task pass to it, and the old child is ended (told to stop first if busy)')
    .option('--note <line>', 'Its Now line on the owner\'s agenda, linked to this child: it moves to Done by itself when the job is done, ended or gone'))
    .action((o: JobOpts & { from?: string; force?: boolean; succeeds?: string; note?: string }) => {
      const note = o.note !== undefined ? { note: o.note } : {};
      if (o.from) return run('delegate', { from: o.from, force: o.force === true, succeeds: o.succeeds, ...note });
      if (!o.prompt) return usage('give --prompt, or --from <pool id>');
      return run('delegate', { ...jobBody(o), succeeds: o.succeeds, ...note });
    });

  s.command('open <kind> [refs...]')
    .description(`Open floating cards: ${KINDS}. Up to 12 refs of one kind at once.\n${OPEN_REF_HELP}`)
    .option('--group <name>', 'Put every card opened here in ONE group of this name (a set the owner asked to see)')
    .option('--no-group', 'Images, PDFs and videos only: leave them as separate cards (they group themselves: 2+ in one call are a new group; one within 2 minutes of the last of its kind joins its group)')
    .option('--shape <shape>', 'small | medium | large | wide (the card\'s size, 1x1 2x1 2x2 3x2 tiles; a size the owner chose is kept), or square | tall (recorded only)')
    .option('--size <size>', 'small | medium | large | wide: the same as --shape with a size (a web or browser card is never under large, and opens side by side; unnamed, a video opens wide and a PDF large)')
    .option('--title <text>', 'Its label (one ref only)')
    .option('--titles <a|b|c>', 'One label per ref, in order, separated by | (several refs)')
    .option('--for <child>', 'Images, PDFs and videos only: the child whose job these show; they go to Others once that job moves on (you send it new work, it is ended, or the owner saw a newer result)')
    .option('--present', 'Images, PDFs and videos only: open AND present them at once (their group whole, else the cards; the layout the cards pick; the owner\'s own layout for the same cards is kept). Pictures you show as a result: always')
    .action((kind: string, refs: string[], o: { shape?: string; size?: string; title?: string; titles?: string; group?: string | false; for?: string; present?: boolean }) => {
      const present = o.present ? { present: true } : {};
      return kind !== 'agenda' && !refs.length ? usage('name at least one ref') : run('open', refs.length <= 1
        ? { kind, ref: refs[0] ?? '', shape: o.shape, size: o.size, title: o.title ?? o.titles?.split('|')[0], group: o.group, for: o.for, ...present }
        : { kind, refs, shape: o.shape, size: o.size, group: o.group, for: o.for, ...present, ...(o.titles ? { titles: o.titles.split('|').map((t) => t.trim()) } : {}) });
    });

  s.command('shape <card> <shape>')
    .description('Size a card: small | medium | large | wide (1x1 2x1 2x2 3x2 tiles); 409 owner_sized when the owner chose its size. square | tall are recorded only (older scripts)')
    .action((container: string, shape: string) => run('shape', { container, shape }));

  s.command('half [card]')
    .description('Show one card side by side with you (half page); --off returns to the floating cards')
    .option('--off', 'Back to the floating cards')
    .action((container: string | undefined, o: { off?: boolean }) => {
      if (!o.off && !container) return usage('name a card, or pass --off');
      return run('half', { container: o.off ? null : container });
    });

  s.command('present [cards...]')
    .description('Presentation of cards in a named layout: spotlight (1), compare (2), grid (2-4), filmstrip (2+, its strip scrolls), review (a page with its child\'s chat); a group id (grp-…) stands for its cards, so `super present <group>` opens the whole group at once; without --layout the cards pick it; --off returns to the floating cards')
    .option('--layout <name>', 'spotlight | compare | grid | filmstrip | review')
    .option('--off', 'Leave the presentation')
    .action((containers: string[], o: { off?: boolean; layout?: string }) => {
      if (!o.off && containers.length === 0) return usage('name cards or a group, or pass --off');
      return run('present', o.off ? { containers: [] } : { containers, ...(o.layout ? { layout: o.layout } : {}) });
    });

  s.command('stack <card>')
    .description('Put a card or a group in Others (bottom right); a grouped card leaves its group')
    .action((container: string) => run('stack', { container }));

  s.command('float <card>')
    .description('Bring a card or a group from Others back to the stage (placed for you); a grouped card leaves its group')
    .action((container: string) => run('float', { container }));

  s.command('close [card]')
    .description('Close a card (a child chat keeps running; `super end` ends it). --group closes every card of a group, --all-groups of every group: a live job\'s card is skipped and stays')
    .option('--group <id>', 'Close all the cards of this group')
    .option('--all-groups', 'Close the cards of every group')
    .option('--others', 'With --all-groups: only the groups in Others')
    .action((container: string | undefined, o: { group?: string; allGroups?: boolean; others?: boolean }) => {
      if (o.group || o.allGroups) {
        if (container) return usage('name a card, or --group / --all-groups, not both');
        return run('close', { ...(o.group ? { group: o.group } : {}), ...(o.allGroups ? { allGroups: true } : {}), ...(o.others ? { others: true } : {}) });
      }
      if (o.others) return usage('--others goes with --all-groups');
      return container ? run('close', { container }) : usage('name a card, or --group <id>, or --all-groups');
    });

  s.command('group <cards...>')
    .description('Put cards together as one tile on the stage; a group id among them adds the rest to that group')
    .option('--name <name>', 'Name the group (or rename it: `super group <group> --name <name>`)')
    .action((cards: string[], o: { name?: string }) => run('group', { containers: cards, name: o.name }));

  s.command('ungroup <targets...>')
    .description('Dissolve a group (its cards take its place on the stage or in Others), or take cards out of their group (they float)')
    .action((targets: string[]) => run('ungroup', { targets }));

  s.command('brief <child> <line>')
    .description('Set the job\'s line in the owner\'s agenda (one plain sentence: what it is doing now); its card shows it too')
    .option('--task <slug>', 'Link the row to this task (state/<slug>.md)')
    .action((child: string, line: string, o: { task?: string }) => run('brief', { child, line, task: o.task }));

  s.command('read <child>')
    .description('A child\'s last reply, whole (tool calls skipped), fenced as the child\'s text. An event line that ends in "…" is cut: this prints the rest')
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
    .description('Send a message into a child chat (steered into its running turn; queued only while it asks). A parked child is woken first, in the same command: "delivered" says how it arrived')
    .action((child: string, text: string) => run('send', { child, text }));

  const team = s.command('team').description('The project\'s AI Team: give a member a job in its own thread');
  team.command('ask <member> <job>')
    .description('Give an AI Team member a job: it lands in the member\'s own thread and runs on its own model, approval and queue. Refused when the member is off (say_disabled) or not approved here (say_unapproved: the owner approves it in AI Team; his queue strip asks him). A busy member queues it (queued: true)')
    .option('--brief <line>', 'The one-line reminder its card shows (default: the job\'s first line)')
    .action((member: string, job: string, o: { brief?: string }) => run('team-ask', { member, text: job, brief: o.brief }));

  const q = s.command('queue').description('The one question queue');
  q.command('list')
    .description('Every queue item: what it is, whose, its state')
    .action(() => run('queue-list', {}));
  q.command('ask <item> <text>')
    .description('Escalate a child\'s question to the owner in your words (never a permission): a notch row, a banner and his phone carry it, his bar holds its buttons; the reply says whether it `reached` him')
    .option('--show <cards...>', 'The cards the stage presents with this question (default: the child\'s option-preview pictures, else the pictures shown for its job in the last 10 minutes); they go back after his answer')
    .option('--no-show', 'Present no cards with this question')
    .action((item: string, text: string, o: { show?: string[] | false }) => run('queue-ask', { item, text, ...showBody(o.show) }));
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

  const n = s.command('note').description('The owner\'s agenda: your notepad of what you do now, what you wait on him for, and what is done (plain words, high level)');
  n.command('add <section> <text...>')
    .description('Write one line: now (what you are doing) | waiting (what you need from the owner) | done (what finished); returns its id (n1, n2, ...)')
    .option('--for <child>', 'A Now line about one job: it moves to Done by itself when that child is done, ended or gone (and back while it works again)')
    .action((section: string, text: string[], o: { for?: string }) => run('note-add', { section, text: text.join(' '), ...(o.for ? { for: o.for } : {}) }));
  n.command('done <id>')
    .description('Move a line to Done (it finished, or the owner gave what you waited for)')
    .action((id: string) => run('note-done', { id }));
  n.command('keep <id>')
    .description('A Now line flagged stale (no job behind it, unchanged for 2 h) still holds: keep it another 2 h')
    .action((id: string) => run('note-keep', { id }));
  n.command('drop <id>')
    .description('Remove a line that no longer holds')
    .action((id: string) => run('note-drop', { id }));
  n.command('clear [section]')
    .description('Empty the agenda (or one section): a new day or a new piece of work starts')
    .action((section?: string) => run('note-clear', section ? { section } : {}));

  s.command('ask [text]')
    .description('Ask the owner YOUR own question (one at a time), in AskUserQuestion\'s own shape: his chat draws it with the same card any agent\'s question gets (title, question, why, options with descriptions or previews, several picks, a note, "Unclear"). It never holds your turn (AskUserQuestion does: never use it). His answer comes back as his next message, `[super answer] …`; the reply says whether it `reached` him')
    .option('--json <spec>', 'The whole question as AskUserQuestion input: {"title":"…","questions":[{"question":"…","header":"…","description":"…","multiSelect":false,"options":[{"label":"…","description":"…","preview":"<html>"}]}],"metadata":{"source":"swipe"}}; inline, @file, or - for stdin')
    .option('--title <line>', 'The context strip: the work and the decision point')
    .option('--description <line>', 'Why you ask now and what changes with the answer')
    .option('--header <chip>', 'A short chip for the question')
    .option('--multi', 'He may pick several options')
    .option('--option <label::description>', 'One option (repeatable), its description after ::', collectOption)
    .option('--options <a|b>', 'Short answers separated by | (the old form; each at most 24 characters)')
    .option('--show <cards...>', 'The cards the stage presents with the question (default: the pictures its option previews\' <img src> point at, else your last picture set within 10 minutes); the server presents them and puts them back after his answer')
    .option('--no-show', 'Present no cards with the question')
    .action((text: string | undefined, o: AskCliOpts) => {
      let body: Record<string, unknown>;
      try { body = buildAskBody(text, o); } catch (err) { usage((err as Error).message); return; }
      return run('ask', body);
    });

  s.command('merge <children...>')
    .description('Merge the branch each child\'s worktree is on now into super/<topic> in its own worktree (nothingToMerge when it brings no commit; never the default branch, never pushed)')
    .requiredOption('--into <topic>', 'The integration branch name (a-z, 0-9, -)')
    .action((children: string[], o: { into: string }) => run('merge', { children, into: o.into }));

  s.command('clean')
    .description('Give disk back from ~/.claude-worktrees. A DRY RUN by default: JSON of what would go (ended children\'s merged worktrees, release worktrees idle 2+ days, any worktree idle 7+ days, node_modules / Rust target of worktrees idle 1+ day, this repo\'s old test temp), totals per category, and what stays with the reason (in use by a process, the global CLI\'s target, a live or asking child, uncommitted changes, commits on no other branch or remote, recent). Deletes only with --apply; ask the owner first. Branches are always kept')
    .option('--apply', 'Really remove what the dry run lists (each row re-checked first)')
    .option('--dry-run', 'Only list (the default; kept for older callers)')
    .action((o: { apply?: boolean; dryRun?: boolean }) => {
      if (o.apply && o.dryRun) { usage('--apply and --dry-run contradict each other: pick one'); return; }
      return run('clean', { apply: o.apply === true });
    });

  // The Super Agent's own handoff: a LOCAL write, like `tasks handoff` (no server round trip),
  // into its file — never a task (super/handoff-file.ts).
  const handoff = s.command('handoff')
    .argument('[note...]', 'Optional extra note, written as the entry\'s last line')
    .description('Hand YOUR session off: write your whole state into your own handoff file (state/.super/handoff.md, never a task) and let a fresh session continue on the same stage. Refuses while any part is missing. Your sub-agents share your pane and are routed here too');
  for (const f of HANDOFF_FIELDS) handoff.option(`${f.flag} <text>`, `${f.label}: ${f.hint}`);
  handoff.action((noteParts: string[], opts: HandoffFields) => { superHandoff(noteParts, opts); });

  const w = s.command('worktree').description('Your children\'s worktrees');
  w.command('list')
    .description('Each child\'s worktree, branch, dirty or clean, merged or not')
    .action(() => run('worktree-list', {}));
  w.command('remove <child>')
    .description('Remove a child\'s worktree; refuses one that is dirty or unmerged')
    .action((child: string) => run('worktree-remove', { child }));
}

/** `super handoff`: the gate, then the file, the record, the digest and the log — in that order,
 *  and nothing at all while a part is missing or this is not the handed-over super session. */
export function superHandoff(noteParts: string[], opts: HandoffFields, env: NodeJS.ProcessEnv = process.env): void {
  const root = ensureContextRoot();
  const ctx = superHandoffContext(root, [env.DREAMCONTEXT_TAB_SESSION, env.CLAUDE_CODE_SESSION_ID]);
  if (!ctx) {
    error('Handoff refused: only the project\'s handed-over Super Agent session writes the super handoff. Anywhere else, use `dreamcontext tasks handoff <task>`.');
    process.exitCode = 1;
    return;
  }
  const gaps = contextHandoffGaps(opts);
  if (gaps.length > 0) {
    error(`Handoff refused: a fresh Super Agent session would start without everything it needs.\n${formatGaps(gaps)}`);
    info(`Re-run with every part answered ("none" is a valid answer except for --done / --next):\n  dreamcontext super handoff ${HANDOFF_FIELDS.map((f) => `${f.flag} "…"`).join(' ')}`);
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  try {
    writeSuperHandoff(root, [renderSuperHandoffEntry(now.toISOString(), opts, noteParts.join(' '))], now);
  } catch (err) {
    error(`Handoff refused: the handoff file could not be written (${(err as Error).message}). Retry in a moment.`);
    process.exitCode = 1;
    return;
  }
  const session = locateHandoffSession(root, env);
  const record: HandoffRecord = {
    task: SUPER_HANDOFF_TASK,
    title: 'Super Agent',
    at: now.toISOString(),
    contextTokens: session.contextTokens,
    fromSession: session.sessionId,
    tab: session.tab || null,
    kind: 'super',
  };
  if (!writeHandoffRecord(root, handoffKey(env), record)) {
    error('The handoff file is written, but the record that opens the fresh session could not be: no rotation will happen. Retry `dreamcontext super handoff`.');
    process.exitCode = 1;
    return;
  }
  writeHandoffArtifacts(root, session);
  success(`Handoff written to _dream_context/${SUPER_HANDOFF_REL}${session.contextTokens !== null ? ` at ~${Math.round(session.contextTokens / 1000)}k tokens` : ''}.`);
  info(session.tab
    ? 'A fresh session opens on the same stage after this turn — finish your sentence and stop.'
    : 'Run /clear in this session to continue from the handoff file.');
}
