/**
 * The member-carry exam's world (Doc's `sinav-seti.md`, 21 Nov): a fictional owner (Deniz Kaya,
 * deniz@example.test), two global members (Mira, funnel; Oren, data) and three projects (kestrel,
 * lumen, fjord), under a fake HOME with a clean env. The built CLI is spawned exactly as Doc's
 * `replay.sh` runs it; delivery is asserted on TEXT (a rule id present or absent on a surface).
 *
 * Surfaces: S session start (`snapshot`), T an owner turn and F a Super event turn (the prompt hook),
 * B the member chat briefing (`prepareAgentChat`), C a child (SubagentStart, a Task dispatch, a
 * `super delegate` child's own start and first turn).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendOwnerTurn, newOwnerTurnId, type OwnerTurnVia } from '../../src/lib/owner-words.js';

export const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

export interface World {
  root: string;
  home: string;
  gitconfig: string;
  project: (name: string) => string;
  context: (name: string) => string;
  dispose: () => void;
}

export interface Run { code: number; out: string; err: string }

let sidN = 0;
/** A fresh session id (the hook's id format). */
export function newSid(tag: string): string {
  sidN += 1;
  return `mc-${tag}-${process.pid}-${sidN}-${Math.random().toString(36).slice(2, 8)}`;
}

function baseEnv(w: World): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: w.home,
    TMPDIR: join(w.root, 'tmp'),
    GIT_CONFIG_GLOBAL: w.gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'en_US.UTF-8',
    DREAMCONTEXT_RECALL: 'off',
    DREAMCONTEXT_NO_UPDATE_CHECK: '1',
  };
}

/** Run the CLI in `cwd` with a clean env plus `env`; `stdin` is written when given. */
export function dc(w: World, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, stdin?: string): Run {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...baseEnv(w), ...env },
    input: stdin ?? '',
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { code: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' };
}

/** Builds the world: three vaults, two global members. `withEmail: false` = no git email (E11). */
export function makeWorld(opts: { withEmail?: boolean; members?: boolean } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'member-carry-')));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'tmp'), { recursive: true });
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, opts.withEmail === false
    ? '[init]\n\tdefaultBranch = main\n[user]\n\tname = Deniz Kaya\n'
    : '[user]\n\tname = Deniz Kaya\n\temail = deniz@example.test\n[init]\n\tdefaultBranch = main\n');
  const w: World = {
    root, home, gitconfig,
    project: (n) => join(root, n),
    context: (n) => join(root, n, '_dream_context'),
    dispose: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
  for (const p of ['kestrel', 'lumen', 'fjord']) {
    const dir = w.project(p);
    mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir, env: baseEnv(w) });
    spawnSync('git', ['-c', 'user.email=deniz@example.test', '-c', 'user.name=Deniz Kaya', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env: baseEnv(w) });
    const r = dc(w, dir, ['init', '-y', '--name', p, '--description', `fictional product ${p}`, '--platforms', 'claude']);
    if (r.code !== 0) throw new Error(`init ${p} failed: ${r.err || r.out}`);
  }
  if (opts.members !== false) {
    const mk = (slug: string, title: string, prompt: string): void => {
      const r = dc(w, w.project('kestrel'), ['agents', 'create', slug, '--scope', 'global', '--title', title, '--prompt', prompt]);
      if (r.code !== 0) throw new Error(`agents create ${slug} failed: ${r.err || r.out}`);
    };
    mk('mira', 'Mira', "Sen Mira'sın: sahibin bütün ürünlerinde çalışan funnel uzmanı. Funnel kurar, ölçer, öğrenir. Harcama ve staging her zaman sorulur.");
    mk('oren', 'Oren', "Sen Oren'sin: sahibin ürünlerinde veri uzmanı. Ölçer ve raporlar.");
  }
  return w;
}

/** A member's own chat (its Super) in a project: the env the server spawns it with. */
export function memberEnv(slug: string, sid: string): NodeJS.ProcessEnv {
  return {
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: sid,
    DREAMCONTEXT_AGENT_CHAT: slug,
    DREAMCONTEXT_MEMBER_SUPER: slug,
    DREAMCONTEXT_MEMBER_CREW: '',
    DREAMCONTEXT_SUPER_CREW: '',
  };
}

/** A child a member's Super delegated (`super delegate`): the crew mark, no chat of its own. */
export function crewEnv(slug: string, sid: string): NodeJS.ProcessEnv {
  return { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sid, DREAMCONTEXT_MEMBER_CREW: slug, DREAMCONTEXT_SUPER_CREW: '' };
}

/** A plain Claude session (no member): a project's main chat or Super. */
export function plainEnv(sid: string): NodeJS.ProcessEnv {
  return { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sid, DREAMCONTEXT_AGENT_CHAT: '', DREAMCONTEXT_MEMBER_CREW: '', DREAMCONTEXT_SUPER_CREW: '' };
}

/** The owner types `own` in the conversation keyed `keys` (what the server's ledger writer records). */
export function ownerSays(w: World, own: string, keys: string[], opts: { vault?: string; surface?: string; via?: OwnerTurnVia } = {}): string {
  const turn = newOwnerTurnId();
  appendOwnerTurn({
    at: new Date(Date.now() - 1000).toISOString(),
    turn,
    vault: opts.vault ?? '',
    surface: opts.surface ?? 'chat',
    via: opts.via ?? 'composer',
    keys,
    session: keys[0] ?? '',
    own,
  }, { home: w.home });
  return turn;
}

/** S: what a session starts with. */
export function surfaceS(w: World, project: string, env: NodeJS.ProcessEnv): string {
  return dc(w, w.project(project), ['snapshot'], env).out;
}

/** Session start through the hook (it also stamps the session, D5). */
export function sessionStart(w: World, project: string, env: NodeJS.ProcessEnv): string {
  const sid = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  return dc(w, w.project(project), ['hook', 'session-start'], env,
    JSON.stringify({ session_id: sid, transcript_path: '', cwd: w.project(project), hook_event_name: 'SessionStart', source: 'startup' })).out;
}

function promptHook(w: World, project: string, env: NodeJS.ProcessEnv, prompt: string, transcript = ''): string {
  const sid = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  return dc(w, w.project(project), ['hook', 'user-prompt-submit'], env,
    JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: w.project(project), hook_event_name: 'UserPromptSubmit', prompt })).out;
}

/** T: an owner turn. */
export function surfaceT(w: World, project: string, env: NodeJS.ProcessEnv, prompt = 'Fiyat ekranını yeniden yaz ve sonucu raporla', transcript = ''): string {
  return promptHook(w, project, env, prompt, transcript);
}

/** F: a Super event turn (English, from the Super). */
export function surfaceF(w: World, project: string, env: NodeJS.ProcessEnv): string {
  return promptHook(w, project, env, '[super events] 1 event\n- from=super: please rewrite the pricing screen copy and report back');
}

/** C: a sub-agent's start in this session, and the dispatch prompt of a Task call. */
export function surfaceC(w: World, project: string, env: NodeJS.ProcessEnv): { start: string; dispatch: string } {
  const sid = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  const start = dc(w, w.project(project), ['hook', 'subagent-start'], env,
    JSON.stringify({ session_id: sid, cwd: w.project(project), hook_event_name: 'SubagentStart', agent_type: 'general-purpose' })).out;
  const dispatch = dc(w, w.project(project), ['hook', 'pre-tool-use'], env,
    JSON.stringify({ session_id: sid, cwd: w.project(project), hook_event_name: 'PreToolUse', permission_mode: 'default', tool_name: 'Task', tool_input: { description: 'copy', prompt: 'Rewrite the pricing copy', subagent_type: 'general-purpose' } })).out;
  return { start, dispatch };
}

/** The rule id a `learn` receipt names, or null. */
export function learnedId(r: Run): string | null {
  const m = /LEARNED ([a-z2-7]{10}) /.exec(`${r.out}\n${r.err}`);
  return m ? m[1]! : null;
}

/** The status a `learn` receipt names, or null. */
export function learnedStatus(r: Run): string | null {
  const m = /LEARNED [a-z2-7]{10} (\w+) /.exec(`${r.out}\n${r.err}`);
  return m ? m[1]! : null;
}
