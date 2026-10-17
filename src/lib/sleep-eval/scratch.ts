import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { roundSourceCtx, sourceDataDir } from './fixtures.js';
import { sleepEvalRoot, type FixtureRound } from './types.js';

/**
 * One round's scratch vault: a throwaway project whose `_dream_context/` holds the board
 * that round saw, and whose `.sleep.json` lists that round's (copied) sessions.
 *
 * Isolation, by layer:
 *   - `dreamcontext` runs through a shim that pins HOME to a fake home INSIDE the scratch
 *     project (the test-isolation-injectable-home pattern) and refuses every verb that
 *     reaches outside the vault (peer delivery, brain/cloud sync, the app).
 *   - `claude` itself keeps the real HOME: it is signed in there, and a fake HOME logs it
 *     out (measured 2026-10-15). Its Bash runs in Claude Code's sandbox, which confines
 *     writes to the scratch project. Edit/Write are NOT in the allow list (an unscoped name
 *     allows every path): acceptEdits approves them inside the scratch project only, and
 *     deny rules name the real brain's state, knowledge, core and .claude outright.
 *   - The task backend is forced to local, so a create can never reach GitHub/ClickUp.
 */

export interface ScratchVault {
  dir: string;
  proj: string;
  ctx: string;
  home: string;
  bin: string;
  /** Lines the shim refused or recorded (peer sends, sync attempts). */
  shimLog: string;
  /** sha256 prefix of the agent definition and skills copied in. */
  agentHash: string;
}

export interface ScratchOptions {
  /** The brain's project root (holds `.claude/agents` and `.claude/skills`). */
  brainProject: string;
  /** The `dreamcontext` entry the shim execs (the code under test). */
  cliEntry: string;
  /** The node binary that runs it. */
  nodeBin: string;
  /** The specialist(s) to install, by agent name. */
  agents: string[];
  /** The CLI version, stamped as setupVersion so `sleep start` runs no migration. */
  cliVersion: string;
  realHome?: string;
}

/** Verbs the shim refuses: everything that writes outside the scratch vault. */
const REFUSED_VERBS = ['brain', 'cloud', 'window', 'notify', 'dashboard', 'app', 'update', 'upgrade', 'setup', 'init'];
const REFUSED_PAIRS = ['lab sync', 'automations run', 'tasks sync', 'tasks push', 'tasks pull', 'peer ask', 'peer send', 'peer mail', 'link add', 'link remove', 'link rm'];

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shimScript(opts: { home: string; log: string; nodeBin: string; cliEntry: string }): string {
  const pairs = REFUSED_PAIRS.map((p) => `  ${shQuote(p)}*) echo "$*" >> ${shQuote(opts.log)}; echo "sleep eval: \\\`dreamcontext ${p}\\\` is recorded, not run, in the scratch vault."; exit 0 ;;`).join('\n');
  return [
    '#!/bin/sh',
    '# sleep-eval shim: the CLI runs against the scratch HOME; outward-facing verbs never run.',
    'case "$1 $2" in',
    pairs,
    'esac',
    'case "$1" in',
    `  ${REFUSED_VERBS.join('|')}) echo "$*" >> ${shQuote(opts.log)}; echo "sleep eval: \\\`dreamcontext $1\\\` is disabled in the scratch vault." >&2; exit 1 ;;`,
    'esac',
    `HOME=${shQuote(opts.home)} exec ${shQuote(opts.nodeBin)} ${shQuote(opts.cliEntry)} "$@"`,
    '',
  ].join('\n');
}

/** The brain's setup config with every outward path cut: local tasks, no brain repo, no links. */
export function sanitizeSetupConfig(raw: Record<string, unknown>, cliVersion: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of ['github', 'clickup', 'brainRepo', 'linkedRepos', 'cloudTaskManagement', 'shareable', 'recallCloud']) delete out[k];
  out.taskBackend = 'local';
  out.setupVersion = cliVersion;
  return out;
}

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function hashTree(paths: string[]): string {
  const h = createHash('sha256');
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(p).sort();
    } catch {
      h.update(p.split('/').pop() ?? '');
      h.update(readFileSync(p));
      return;
    }
    for (const e of entries) walk(join(p, e));
  };
  for (const p of paths) walk(p);
  return h.digest('hex').slice(0, 12);
}

/** The skills installed next to the specialist. */
const AGENT_SKILLS = ['dreamcontext', 'dreamcontext-agent-core'];

/**
 * sha256 prefix of the specialist(s) and skills a scratch vault gets from `projectRoot`
 * (a brain's project root, or a kept scratch vault's `proj`: the hash reads names and
 * bytes only, so a faithful copy hashes the same).
 */
export function agentDefinitionHash(projectRoot: string, agents: string[]): string {
  return hashTree([
    ...agents.map((a) => join(projectRoot, '.claude', 'agents', `${a}.md`)),
    ...AGENT_SKILLS.map((sk) => join(projectRoot, '.claude', 'skills', sk)),
  ]);
}

/** Session task slugs, as the Stop hook would have recorded them: tasks the session touched. */
export function sessionTaskSlugs(transcript: string, board: Set<string>): string[] {
  let raw = '';
  try {
    raw = readFileSync(transcript, 'utf-8');
  } catch {
    return [];
  }
  const found = new Set<string>();
  const re = /(?:tasks\s+(?:log|insert|status|complete|field|start|due|objectives)\s+["']?|_dream_context\/state\/)([a-z0-9][a-z0-9-]{2,})/g;
  for (const m of raw.matchAll(re)) if (board.has(m[1])) found.add(m[1]);
  return [...found].sort();
}

/**
 * Drop changelog entries dated after `day` (YYYY-MM-DD). The frozen board is TODAY's task
 * files; without this a replayed round reads its own future in every task log ("already
 * consolidated on 10-12") and judges with knowledge the real sleep never had. Entries of
 * the round's own day stay: same-day work did happen before the sleep. The body above the
 * changelog stays today's; the report says so.
 */
export function trimChangelogAfter(md: string, day: string): string {
  const at = md.search(/^## Changelog\b/m);
  if (at < 0) return md;
  const head = md.slice(0, at);
  const lines = md.slice(at).split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const entry = line.match(/^### (\d{4}-\d{2}-\d{2})\b/);
    if (entry) skipping = entry[1] > day;
    else if (/^## /.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return head + out.join('\n');
}

export function prepareScratch(contextRoot: string, round: FixtureRound, dir: string, opts: ScratchOptions): ScratchVault {
  const evalRoot = sleepEvalRoot(contextRoot);
  const fixtureDir = join(evalRoot, 'fixtures', round.id);
  // A round cut from another brain takes that brain's files; the specialist stays this one's.
  const srcCtx = roundSourceCtx(contextRoot, round);
  const dataDir = sourceDataDir(contextRoot, round);
  const proj = join(dir, 'proj');
  const ctx = join(proj, '_dream_context');
  const home = join(proj, '.eval-home');
  const bin = join(dir, 'bin');
  const shimLog = join(proj, '.eval-shim.log');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  mkdirSync(bin, { recursive: true });

  // The local embedding model, read-only, so the filing bar's neighbor check runs as it does for real.
  const models = join(opts.realHome ?? homedir(), '.dreamcontext', 'models');
  if (existsSync(models)) symlinkSync(models, join(home, '.dreamcontext', 'models'));

  // Brain content the specialist reads: identity, knowledge, people, overrides.
  for (const sub of ['core', 'knowledge', 'people', 'overrides']) {
    const src = join(srcCtx, sub);
    if (existsSync(src)) cpSync(src, join(ctx, sub), { recursive: true });
  }

  // The board this round saw, from the frozen copy.
  const board = new Set(round.board);
  const day = round.consolidatedAt.slice(0, 10);
  for (const slug of round.board) {
    const src = join(dataDir, 'board', `${slug}.md`);
    if (existsSync(src)) writeFileSync(join(ctx, 'state', `${slug}.md`), trimChangelogAfter(readFileSync(src, 'utf-8'), day));
  }

  const state = join(srcCtx, 'state');
  const config = readJson<Record<string, unknown>>(join(state, '.config.json'), {});
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify(sanitizeSetupConfig(config, opts.cliVersion), null, 2) + '\n');

  // Memory of what came before: history, declines and tombstones as they stood then.
  const before = (at: unknown) => typeof at === 'string' && at < round.consolidatedAt;
  const history = readJson<Array<{ consolidated_at?: string }>>(join(dataDir, 'sleep-history.json'), []);
  writeFileSync(join(ctx, 'state', '.sleep-history.json'), JSON.stringify(history.filter((h) => before(h.consolidated_at)), null, 2) + '\n');
  const declined = readJson<Array<{ declinedAt?: string }>>(join(dataDir, 'task-declined.json'), []);
  if (Array.isArray(declined)) {
    writeFileSync(join(ctx, 'state', '.task-declined.json'), JSON.stringify(declined.filter((d) => before(d.declinedAt)), null, 2) + '\n');
  }
  const connections = join(state, '.connections.json');
  if (existsSync(connections)) copyFileSync(connections, join(ctx, 'state', '.connections.json'));
  const tombstones = readJson<unknown>(join(dataDir, 'task-tombstones.json'), null);
  if (tombstones !== null) writeFileSync(join(ctx, 'state', '.task-tombstones.json'), JSON.stringify(tombstones, null, 2) + '\n');

  // The round's sessions, oldest first, pointing at the frozen transcript copies.
  const sessions = round.sessions.map((s) => {
    const transcript = join(fixtureDir, s.file);
    return {
      session_id: s.session_id,
      transcript_path: transcript,
      stopped_at: s.stopped_at,
      last_assistant_message: s.last_assistant_message,
      change_count: null,
      tool_count: null,
      score: null,
      task_slugs: sessionTaskSlugs(transcript, board),
    };
  });
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({
    debt: 0,
    last_sleep: round.previousAt ? round.previousAt.slice(0, 10) : null,
    last_consolidated_at: round.previousAt,
    sessions,
    bookmarks: [],
    recall_mode: 'hybrid',
  }, null, 2) + '\n');

  // The embedding cache is content-addressed: copying it means only changed chunks re-embed.
  const cache = join(srcCtx, '.embeddings', 'cache.json');
  if (existsSync(cache)) {
    mkdirSync(join(ctx, '.embeddings'), { recursive: true });
    copyFileSync(cache, join(ctx, '.embeddings', 'cache.json'));
    writeFileSync(join(ctx, '.embeddings', '.gitignore'), '*\n');
  }

  // The specialist exactly as this brain installed it, its skills, and no hooks.
  const claudeDir = join(proj, '.claude');
  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  for (const agent of opts.agents) {
    const src = join(opts.brainProject, '.claude', 'agents', `${agent}.md`);
    if (!existsSync(src)) throw new Error(`Agent not installed in the brain: ${src}`);
    copyFileSync(src, join(claudeDir, 'agents', `${agent}.md`));
  }
  for (const skill of AGENT_SKILLS) {
    const src = join(opts.brainProject, '.claude', 'skills', skill);
    if (existsSync(src)) cpSync(src, join(claudeDir, 'skills', skill), { recursive: true });
  }
  // `//` = an absolute path in Claude Code permission rules.
  const realDirs = [...new Set([contextRoot, srcCtx])].flatMap((c) => [join(c, 'state'), join(c, 'knowledge'), join(c, 'core')]);
  realDirs.push(join(opts.brainProject, '.claude'), join(dirname(srcCtx), '.claude'));
  const deny = realDirs.flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`]);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'acceptEdits', deny },
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  }, null, 2) + '\n');

  const shim = join(bin, 'dreamcontext');
  writeFileSync(shim, shimScript({ home, log: shimLog, nodeBin: opts.nodeBin, cliEntry: opts.cliEntry }));
  chmodSync(shim, 0o755);

  return { dir, proj, ctx, home, bin, shimLog, agentHash: agentDefinitionHash(opts.brainProject, opts.agents) };
}
