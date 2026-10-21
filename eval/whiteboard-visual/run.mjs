#!/usr/bin/env node
/**
 * eval:whiteboard-visual — asked to "put something on the whiteboard that explains how X works",
 * does a REAL agent draw it (the excalidraw kit: a flow, groups, short labels) or stack notes?
 * Optional and PAID (one real `claude` turn per run), never in CI.
 *
 *   [SCENARIO=sync|screens] [RUN=n] node eval/whiteboard-visual/run.mjs <before|after> <main|agent>
 *
 *   before  the CLI, skills and briefings of BEFORE_REF (default HEAD), from a `git archive`
 *   after   this checkout's working tree
 *   main    a Chat tab: the project's own skills, bypassPermissions
 *   agent   a home-board agent's card: no skills, the board scope's exact allowlist
 *
 * Both variants run the CLI from its TypeScript source (ts-register.mjs, no build). Each run gets
 * a fresh synthetic vault ("Lumen Notes", fixture/) and a scratch HOME linking the owner's real
 * ~/.claude sign-in, so the owner's ~/.dreamcontext is never touched. Out: tmp/eval-whiteboard-visual/
 * <variant>-<actor>.png (the board, `whiteboard render`), .json (what is on it) and .jsonl (the turn).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'tmp', 'eval-whiteboard-visual');
const [variant, actor] = process.argv.slice(2);
if (!['before', 'after'].includes(variant) || !['main', 'agent'].includes(actor)) {
  console.error('usage: node eval/whiteboard-visual/run.mjs <before|after> <main|agent>');
  process.exit(2);
}
// Two request shapes. `sync`: explain how something works. `screens`: show pictures and say what
// each is for (the shape of the owner's note-heavy board, 2026-10-20: screenshots + long notes).
const SCENARIO = process.env.SCENARIO || 'sync';
const PROMPTS = {
  sync: "Whiteboard'a Lumen'in senkronizasyon motorunun nasıl çalıştığını anlatan bir şey kur.",
  screens: "Whiteboard'a telefon uygulamasının üç ekranını koy ve her birinin ne işe yaradığını anlat.",
};
if (!PROMPTS[SCENARIO]) throw new Error(`SCENARIO is one of ${Object.keys(PROMPTS).join(', ')}`);
const PROMPT = process.env.EVAL_PROMPT || PROMPTS[SCENARIO];
const BOARD = 'control-panel';
const AGENT = 'pano';
const REAL_HOME = homedir();
const CLAUDE_BIN = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf-8' }).stdout.trim();
const LOADER = join(HERE, 'ts-register.mjs');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} → ${r.status}\n${r.stderr || r.stdout}`);
  return r;
}

/** The source tree under test: this checkout, or BEFORE_REF unpacked beside the output. */
function sourceTree() {
  if (variant === 'after') return REPO;
  const ref = process.env.BEFORE_REF || 'HEAD';
  const dir = join(OUT, `before-tree-${sh('git', ['-C', REPO, 'rev-parse', '--short', ref]).stdout.trim()}`);
  if (!existsSync(join(dir, 'src'))) {
    mkdirSync(dir, { recursive: true });
    sh('/bin/sh', ['-c', `git -C "${REPO}" archive "${ref}" | tar -x -C "${dir}"`]);
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  }
  return dir;
}

const SRC = sourceTree();
const root = join(tmpdir(), `dreamcontext-eval-wb-visual-${variant}-${actor}-${process.pid}`);
rmSync(root, { recursive: true, force: true });
// The scratch HOME holds a copy of ~/.claude.json: it goes on every exit, a failed setup included.
let scratchDir = null;
process.on('exit', () => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
});
// A signal does not fire `exit` on its own: turn Ctrl-C and a kill into one, so the copy goes too.
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
const home = join(root, 'home');
const proj = join(root, 'lumen-notes');
const bin = join(root, 'bin');
for (const d of [join(home, '.dreamcontext'), proj, bin, OUT]) mkdirSync(d, { recursive: true });
writeFileSync(join(bin, 'dreamcontext'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(LOADER)} ${JSON.stringify(join(SRC, 'src', 'cli', 'index.ts'))} "$@"\n`);
chmodSync(join(bin, 'dreamcontext'), 0o755);
// Claude's sign-in, exactly as eval/super-show does it: a link to the real ~/.claude, a COPY of
// ~/.claude.json (never written back), and the keychain folder.
symlinkSync(join(REAL_HOME, '.claude'), join(home, '.claude'));
try { copyFileSync(join(REAL_HOME, '.claude.json'), join(home, '.claude.json')); } catch { /* none */ }
mkdirSync(join(home, 'Library'), { recursive: true });
symlinkSync(join(REAL_HOME, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'));
const { CLAUDE_CONFIG_DIR: _cfg, ...base } = process.env;
const env = {
  ...base, HOME: home, DREAMCONTEXT_AUTO_DASHBOARD: '0',
  PATH: [bin, dirname(CLAUDE_BIN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
};
const dc = (...a) => sh(join(bin, 'dreamcontext'), a, { cwd: proj, env });

// ── The vault ─────────────────────────────────────────────────────────────────────────────
sh('git', ['-C', proj, 'init', '-q']);
// The owner's own install path: skills (dreamcontext + the excalidraw pack), agents, hooks, CLAUDE.md.
dc('setup', '--defaults', '-y', '--platforms', 'claude', '--packs', 'excalidraw', '--skip-app', '--skip-machine', '--no-start');
mkdirSync(join(proj, '_dream_context', 'knowledge'), { recursive: true });
copyFileSync(join(HERE, 'fixture', 'sync-engine.md'), join(proj, '_dream_context', 'knowledge', 'sync-engine.md'));
if (SCENARIO === 'screens') {
  // The pictures are drawn by the kit and rendered by the CLI, so the fixture holds no binaries.
  const { buildExcalidraw } = createRequire(import.meta.url)(join(REPO, 'skill-packs', 'excalidraw', 'scripts', 'build_excalidraw.js'));
  mkdirSync(join(proj, 'docs', 'screens'), { recursive: true });
  for (const name of ['notes-list', 'editor', 'sync-status']) {
    const md = join(root, `${name}.excalidraw.md`);
    buildExcalidraw({ ...JSON.parse(readFileSync(join(HERE, 'fixture', 'screens', `${name}.json`), 'utf-8')), out: md });
    dc('whiteboard', 'render', '--file', md, '--out', join(proj, 'docs', 'screens', `${name}.png`), '--scale', '2');
  }
  copyFileSync(join(HERE, 'fixture', 'screens.md'), join(proj, '_dream_context', 'knowledge', 'screens.md'));
}
dc('whiteboard', 'create', 'Control Panel');
if (actor === 'agent') {
  dc('agents', 'create', AGENT, '--title', 'Pano', '--whiteboard', BOARD,
    '--prompt', 'Sen Lumen Notes ekibinin kontrol paneli tahtasının yardımcısısın. Sahip tahtada ne kurmanı isterse onu kurarsın.');
}

// ── One real turn ─────────────────────────────────────────────────────────────────────────
const envelope = JSON.parse(sh(process.execPath, ['--import', LOADER, join(HERE, 'envelope.mjs'), SRC, join(proj, '_dream_context'), actor, AGENT, BOARD], { cwd: proj, env }).stdout);
// A card's scope made a `dc-board-*` scratch folder that outlives envelope.mjs on purpose (the chat
// writes into it); the dashboard disposes it after the session, so this run does too.
scratchDir = envelope.env.DREAMCONTEXT_AGENT_SCRATCH ?? null;
const brief = join(root, 'brief.md');
writeFileSync(brief, envelope.briefing);
const argv = [
  '-p', PROMPT, '--output-format', 'stream-json', '--verbose',
  ...envelope.permissionArgs,
  '--append-system-prompt-file', brief,
  ...(actor === 'main' ? ['--disallowedTools', 'EnterPlanMode,ExitPlanMode'] : []),
  ...(process.env.EVAL_MODEL ? ['--model', process.env.EVAL_MODEL] : []),
];
const started = Date.now();
// DRY=1 sets everything up and skips the paid turn (a check of the harness itself).
const turn = process.env.DRY
  ? { stdout: '', status: 0 }
  : sh(CLAUDE_BIN, argv, { cwd: proj, env: { ...env, ...envelope.env }, allowFail: true, timeout: 20 * 60_000 });
const tag = `${SCENARIO === 'sync' ? '' : `${SCENARIO}-`}${variant}-${actor}${process.env.RUN ? `-${process.env.RUN}` : ''}`;
writeFileSync(join(OUT, `${tag}.jsonl`), turn.stdout);

// ── What the turn did, and what is on the board ──────────────────────────────────────────
const frames = turn.stdout.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const tools = frames.filter((f) => f.type === 'assistant').flatMap((f) => (f.message?.content ?? []).filter((c) => c.type === 'tool_use'));
const result = frames.find((f) => f.type === 'result') ?? {};
// Every board the turn touched, not only the default one: an agent may well open its own.
const words = (s) => (s ?? '').split(/\s+/).filter(Boolean).length;
const boards = JSON.parse(dc('whiteboard', 'list', '--json').stdout).map((b) => b.slug).flatMap((slug) => {
  const live = JSON.parse(dc('whiteboard', 'show', slug, '--json').stdout).elements;
  if (live.length === 0) return [];
  const widgets = live.filter((e) => e.kind);
  const notes = widgets.filter((e) => e.kind === 'note');
  const drawnText = live.filter((e) => e.type === 'text');
  const count = (list, key) => Object.fromEntries([...new Set(list.map(key))].map((k) => [k, list.filter((e) => key(e) === k).length]));
  const png = join(OUT, `${tag}-${slug}.png`);
  dc('whiteboard', 'render', slug, '--out', png);
  return [{
    slug, png, elements: live.length,
    widgets: count(widgets, (w) => w.kind),
    noteWords: notes.reduce((n, e) => n + words(JSON.parse(dc('whiteboard', 'show', slug, e.id, '--full', '--json').stdout).markdown), 0),
    drawn: count(live.filter((e) => !e.kind), (e) => e.type),
    drawnTextWords: drawnText.reduce((n, e) => n + words(e.text), 0),
    longestDrawnText: Math.max(0, ...drawnText.map((e) => words(e.text))),
  }];
});
const summary = {
  scenario: SCENARIO, variant, actor, prompt: PROMPT, source: SRC, model: frames.find((f) => f.type === 'system')?.model ?? null,
  seconds: Math.round((Date.now() - started) / 1000), cost: result.total_cost_usd ?? null, exit: turn.status,
  skills: tools.filter((t) => t.name === 'Skill').map((t) => t.input?.skill),
  reads: tools.filter((t) => t.name === 'Read').map((t) => String(t.input?.file_path ?? '').replace(proj, '.')),
  commands: tools.filter((t) => t.name === 'Bash').map((t) => String(t.input?.command ?? '').split('\n')[0].slice(0, 200)),
  boards,
  answer: result.result ?? null,
};
writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
