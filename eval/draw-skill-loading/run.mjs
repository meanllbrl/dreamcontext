#!/usr/bin/env node
/**
 * eval:draw-skill-loading — asked to draw, does a REAL agent open the drawing skill BEFORE its first
 * drawing action? Optional and PAID (one real turn per case), never in CI.
 *
 *   [CASES=wb-en,wb-tr,...] [TOOL=claude|codex|antigravity] node eval/draw-skill-loading/run.mjs <before|after>
 *
 *   before  BEFORE_REF (default fba3b1c2, the last tree with the excalidraw pack), pack installed:
 *           an open of `excalidraw` counts
 *   after   this checkout's working tree: an open of `draw` counts
 *
 * Positives (6): whiteboard EN/TR, file diagram EN/TR, knowledge diagram, wireframe file. The metric:
 * the skill is opened (a Skill call, or a Read of its SKILL.md) before the first drawing action (a
 * spec or `.excalidraw.md` written, the builder run, `whiteboard draw|add`). Negatives (2): in the
 * Chat view "sync akışını çiz" should answer with a dc-graph and write no `.excalidraw.md` (opening
 * the skill is not counted against it); "fix the drawer bug" should open nothing.
 *
 * Each case gets a fresh synthetic vault ("Lumen Notes", the whiteboard-visual fixture) and a scratch
 * HOME linking the owner's real ~/.claude sign-in; ~/.dreamcontext is never touched. The CLI runs
 * from TypeScript source (no build). Out: tmp/eval-draw-skill-loading/<variant>-<case>.{jsonl,json}
 * and <variant>-summary.json. TOOL=codex|antigravity runs one whiteboard case through
 * `dreamcontext ask --tool` (after only).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURE = join(REPO, 'eval', 'whiteboard-visual', 'fixture');
const LOADER = join(REPO, 'eval', 'whiteboard-visual', 'ts-register.mjs');
const OUT = join(REPO, 'tmp', 'eval-draw-skill-loading');
const variant = process.argv[2];
if (!['before', 'after'].includes(variant)) {
  console.error('usage: node eval/draw-skill-loading/run.mjs <before|after>');
  process.exit(2);
}
const TOOL = process.env.TOOL || 'claude';
const SKILL = variant === 'before' ? 'excalidraw' : 'draw';

const CASES = [
  { id: 'wb-en', positive: true, prompt: 'Draw how the Lumen sync engine works on the control panel whiteboard.' },
  { id: 'wb-tr', positive: true, prompt: "Kontrol paneli whiteboard'una Lumen'in senkronizasyon akışını çiz." },
  { id: 'file-en', positive: true, prompt: 'Make an Excalidraw diagram of the Lumen sync engine at docs/sync.excalidraw.md.' },
  { id: 'file-tr', positive: true, prompt: "Lumen'in senkronizasyon motorunun excalidraw diyagramını docs/senkron.excalidraw.md olarak çiz." },
  { id: 'knowledge', positive: true, prompt: 'Add a knowledge diagram of the sync engine to the brain, next to the sync-engine knowledge file.' },
  { id: 'wireframe', positive: true, prompt: 'Draw a wireframe of the Lumen notes list screen as an Excalidraw file in docs/.' },
  { id: 'chat-sketch', positive: false, chat: true, prompt: 'sync akışını çiz' },
  { id: 'drawer', positive: false, prompt: 'Fix the drawer bug: the settings drawer does not close on mobile. Just tell me where you would look; change nothing.' },
];
const pick = process.env.CASES ? process.env.CASES.split(',') : null;
const cases = TOOL === 'claude' ? CASES.filter((c) => !pick || pick.includes(c.id)) : CASES.filter((c) => c.id === 'wb-en');
const REAL_HOME = homedir();
const CLAUDE_BIN = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf-8' }).stdout.trim();

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} → ${r.status}\n${r.stderr || r.stdout}`);
  return r;
}

function sourceTree() {
  if (variant === 'after') return REPO;
  const ref = process.env.BEFORE_REF || 'fba3b1c2';
  const dir = join(OUT, `before-tree-${sh('git', ['-C', REPO, 'rev-parse', '--short', ref]).stdout.trim()}`);
  if (!existsSync(join(dir, 'src'))) {
    mkdirSync(dir, { recursive: true });
    sh('/bin/sh', ['-c', `git -C "${REPO}" archive "${ref}" | tar -x -C "${dir}"`]);
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  }
  return dir;
}
const SRC = sourceTree();
mkdirSync(OUT, { recursive: true });

/** What the turn did, in order: the skill opened, the first drawing action. */
function score(stdout, proj) {
  const frames = stdout.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const tools = frames.filter((f) => f.type === 'assistant').flatMap((f) => (f.message?.content ?? []).filter((c) => c.type === 'tool_use'));
  const isOpen = (t) => (t.name === 'Skill' && String(t.input?.skill ?? '') === SKILL)
    || (t.name === 'Read' && new RegExp(`skills/${SKILL}/SKILL\\.md$`).test(String(t.input?.file_path ?? '')));
  const isDraw = (t) => {
    const path = String(t.input?.file_path ?? '');
    const cmd = String(t.input?.command ?? '');
    if ((t.name === 'Write' || t.name === 'Edit') && (/\.excalidraw(\.md)?$/.test(path) || /spec[^/]*\.json$|\.board\.cjs$/.test(path))) return true;
    return t.name === 'Bash' && (/build_excalidraw\.js|\.board\.cjs/.test(cmd) || /whiteboard\s+(draw|add)\b/.test(cmd));
  };
  const openAt = tools.findIndex(isOpen);
  const drawAt = tools.findIndex(isDraw);
  const result = frames.find((f) => f.type === 'result') ?? {};
  const answer = String(result.result ?? '');
  const wroteBoard = tools.some((t) => (t.name === 'Write') && /\.excalidraw(\.md)?$/.test(String(t.input?.file_path ?? '')))
    || tools.some((t) => t.name === 'Bash' && /build_excalidraw|whiteboard\s+draw/.test(String(t.input?.command ?? '')));
  return {
    opened: openAt >= 0, openedBeforeDrawing: openAt >= 0 && (drawAt < 0 || openAt < drawAt), drew: drawAt >= 0,
    dcGraph: /dc-graph/.test(answer), wroteBoard, cost: result.total_cost_usd ?? null,
    skills: tools.filter((t) => t.name === 'Skill').map((t) => t.input?.skill),
    firstTools: tools.slice(0, 12).map((t) => `${t.name}:${String(t.input?.skill ?? t.input?.file_path ?? t.input?.command ?? '').replace(proj, '.').split('\n')[0].slice(0, 120)}`),
  };
}

function runCase(c) {
  const root = join(tmpdir(), `dreamcontext-eval-draw-${variant}-${c.id}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, 'home');
  const proj = join(root, 'lumen-notes');
  const bin = join(root, 'bin');
  for (const d of [join(home, '.dreamcontext'), proj, bin]) mkdirSync(d, { recursive: true });
  try {
    // `ask --tool` spawns the CLI again without the TS loader: a built tree runs from dist.
    const built = join(SRC, 'dist', 'index.js');
    writeFileSync(join(bin, 'dreamcontext'), existsSync(built)
      ? `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(built)} "$@"\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(LOADER)} ${JSON.stringify(join(SRC, 'src', 'cli', 'index.ts'))} "$@"\n`);
    chmodSync(join(bin, 'dreamcontext'), 0o755);
    symlinkSync(join(REAL_HOME, '.claude'), join(home, '.claude'));
    try { copyFileSync(join(REAL_HOME, '.claude.json'), join(home, '.claude.json')); } catch { /* none */ }
    for (const d of ['.codex', '.gemini']) if (existsSync(join(REAL_HOME, d))) symlinkSync(join(REAL_HOME, d), join(home, d));
    mkdirSync(join(home, 'Library'), { recursive: true });
    symlinkSync(join(REAL_HOME, 'Library', 'Keychains'), join(home, 'Library', 'Keychains'));
    const { CLAUDE_CONFIG_DIR: _cfg, DREAMCONTEXT_CHAT_TAB: _tab, CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _ep, ...base } = process.env;
    const env = {
      ...base, HOME: home, DREAMCONTEXT_AUTO_DASHBOARD: '0',
      PATH: [bin, dirname(CLAUDE_BIN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    };
    const dc = (...a) => sh(join(bin, 'dreamcontext'), a, { cwd: proj, env });
    sh('git', ['-C', proj, 'init', '-q']);
    const packs = variant === 'before' ? ['--packs', 'excalidraw'] : [];
    dc('setup', '--defaults', '-y', '--platforms', 'claude', ...packs, '--skip-app', '--skip-machine', '--no-start');
    mkdirSync(join(proj, '_dream_context', 'knowledge'), { recursive: true });
    copyFileSync(join(FIXTURE, 'sync-engine.md'), join(proj, '_dream_context', 'knowledge', 'sync-engine.md'));
    mkdirSync(join(proj, 'docs'), { recursive: true });
    dc('whiteboard', 'create', 'Control Panel');

    let stdout = '';
    if (TOOL !== 'claude') {
      // Read-only: Codex --write needs the Mac-wide gate of a matching global install, Antigravity has no edits-only mode; reading still shows whether the skill is opened.
      stdout = sh(join(bin, 'dreamcontext'), ['ask', '--tool', TOOL, '--json', c.prompt], { cwd: proj, env, allowFail: true, timeout: 20 * 60_000 }).stdout;
    } else {
      const brief = join(root, 'brief.md');
      const chatEnv = {};
      const argv = ['-p', c.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'EnterPlanMode,ExitPlanMode'];
      if (c.chat) {
        const { CHAT_SURFACE_BRIEFING } = JSON.parse(sh(process.execPath, ['--import', LOADER, '-e',
          `import(${JSON.stringify(join(SRC, 'src', 'server', 'chat-surface.ts'))}).then((m) => console.log(JSON.stringify({ CHAT_SURFACE_BRIEFING: m.CHAT_SURFACE_BRIEFING })))`], { cwd: proj, env }).stdout);
        writeFileSync(brief, CHAT_SURFACE_BRIEFING);
        argv.push('--append-system-prompt-file', brief);
        chatEnv.DREAMCONTEXT_CHAT_TAB = '1';
      }
      if (process.env.EVAL_MODEL) argv.push('--model', process.env.EVAL_MODEL);
      stdout = process.env.DRY ? '' : sh(CLAUDE_BIN, argv, { cwd: proj, env: { ...env, ...chatEnv }, allowFail: true, timeout: 20 * 60_000 }).stdout;
    }
    writeFileSync(join(OUT, `${variant}-${TOOL}-${c.id}.jsonl`), stdout);
    const s = TOOL === 'claude' ? score(stdout, proj) : { opened: new RegExp(`skills/${SKILL}/SKILL\\.md|\\b${SKILL}\\b skill`).test(stdout), raw: stdout.slice(-2000) };
    const row = { case: c.id, positive: c.positive, prompt: c.prompt, tool: TOOL, ...s };
    writeFileSync(join(OUT, `${variant}-${TOOL}-${c.id}.json`), JSON.stringify(row, null, 2));
    return row;
  } finally {
    if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
  }
}

const rows = [];
for (const c of cases) {
  const row = runCase(c);
  rows.push(row);
  console.log(JSON.stringify({ case: row.case, opened: row.opened, openedBeforeDrawing: row.openedBeforeDrawing, dcGraph: row.dcGraph, wroteBoard: row.wroteBoard }));
}
const positives = rows.filter((r) => r.positive);
const summary = {
  variant, tool: TOOL, skill: SKILL, source: SRC,
  positivesOpenedFirst: `${positives.filter((r) => r.openedBeforeDrawing).length}/${positives.length}`,
  chatSketch: rows.find((r) => r.case === 'chat-sketch') ?? null,
  drawer: rows.find((r) => r.case === 'drawer') ?? null,
  rows,
};
writeFileSync(join(OUT, `${variant}-${TOOL}-summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ variant, tool: TOOL, positivesOpenedFirst: summary.positivesOpenedFirst }, null, 2));
