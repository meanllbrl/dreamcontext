/**
 * An app's assistant (plan r9): who talks in the app, and the envelope its conversation runs in.
 *
 *  - The OWN assistant: plain Claude, its role in the literal `ASSISTANT.md` at the app root. It is
 *    no team member: no automation manifest, no thread file, no entry in AI Team or `getRunTarget`.
 *  - A BOUND member: an AI Team agent, under its approved identity and its level, capped at `auto`.
 *
 * `prepareAppChat` runs at every spawn (Resume and account restart included) and decides from disk,
 * so a role or manifest edit can narrow what a conversation may do and an unknown one refuses.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ANYWHERE, CREDENTIAL_HOME_FILES, credentialHomeDirs, forbiddenPathReason, rulePath } from '../automations/board-scope.js';
import { LIGHT_DISALLOWED_TOOLS } from '../automations/light-run.js';
import { sanitizeAutomationPrompt } from '../automations/runner.js';
import { getRunTarget } from '../automations/store.js';
import { AGENT_CHAT_ENV, DEFAULT_AGENT_AUTONOMY } from '../automations/types.js';
import { levelPermissionArgs } from '../agents/permission.js';
import { prepareAgentChat } from '../whiteboards/card-chat.js';
import { knownMcpServers, removeLeanMcpConfig, writeLeanMcpConfig } from '../super/lean-mcp.js';
import { LISTED_VERBS, type BashGateContext } from './bash-gate.js';
import { gateFilePath, type AppChatRecord } from './chat-store.js';
import { MANIFEST_FILE, ROLE_FILE, cleanText, readManifest, roleFileProblem, type AppManifest } from './manifest.js';
import { appChatsDir, appDataDir, appsHome, getApp, real, registryPath } from './registry.js';

/** The role's cap: the same trust as the backend command, kept small because it rides every turn. */
export const ROLE_MAX_CHARS = 8000;

export type AppAgentChoice = { kind: 'member'; member: string } | { kind: 'own' } | { kind: 'none' };

/**
 * Who talks in this app. The one place that decides it: manifest member, then the own assistant,
 * then an embed URL's `member` (old apps; a home-board agent is refused), then nobody, which keeps
 * drawing today's screen, so an old app with no agent looks exactly as it does now.
 */
export function resolveAppAgent(
  manifest: Pick<AppManifest, 'agent'> | null,
  urlMember: string | null,
  isBoardMember: (slug: string) => boolean = () => false,
): AppAgentChoice {
  if (manifest?.agent?.member) return { kind: 'member', member: manifest.agent.member };
  if (manifest?.agent?.own) return { kind: 'own' };
  if (urlMember && !isBoardMember(urlMember)) return { kind: 'member', member: urlMember };
  return { kind: 'none' };
}

/** What runs with no card. Everything else that needs a permission raises one. */
export function appAllowedTools(input: {
  slug: string; dataDir: string; actions: readonly { id: string; danger?: boolean }[]; readTools: readonly string[];
}): string[] {
  const verbs = LISTED_VERBS.filter((v) => !v.action).map((v) => (
    `Bash(dreamcontext ${v.words.join(' ')}${v.ownSlug ? ` ${input.slug}` : ''}:*)`
  ));
  const doVerbs = input.actions.filter((a) => !a.danger).map((a) => `Bash(dreamcontext apps do ${input.slug} ${a.id}:*)`);
  return [
    'Read', 'Skill', 'ToolSearch', 'TodoWrite',
    `Edit(/${rulePath(input.dataDir)}/**)`, `Write(/${rulePath(input.dataDir)}/**)`,
    ...verbs, ...doVerbs, ...input.readTools,
  ];
}

/**
 * Tools that take no permission are denied outright, because a card would never come (probed:
 * `CronCreate` ran, `EnterWorktree` was not refused). Derived from the light job's list so it
 * cannot drift: the non-file entries, minus what stays usable here or raises a card.
 */
export function appDeniedTools(): string[] {
  const keep = new Set<string>([
    'AskUserQuestion', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'WebFetch', 'WebSearch', 'Bash',
    'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  ]);
  return LIGHT_DISALLOWED_TOOLS.filter((t) => !keep.has(t));
}

/** This product's own secrets, in any project on the machine: `Read` is not limited to this one. */
export const APP_CREDENTIAL_FILES = ['**/.secrets.json', '**/lab/credentials.json', '**/.mcp.json'] as const;

function childRules(dir: string, skip: ReadonlySet<string>): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const rules: string[] = [];
  for (const name of names) {
    if (skip.has(name)) continue;
    let isDir = false;
    try { isDir = statSync(join(dir, name)).isDirectory(); } catch { /* a dangling entry: as a file */ }
    rules.push(`Read(/${rulePath(join(dir, name))}${isDir ? '/**' : ''})`);
  }
  return rules;
}

/**
 * Credential reads. A deny outranks an allow, so "all of `~/.dreamcontext` minus the data dir"
 * cannot be written: its children are enumerated, other apps' data dirs and the Assistant's hidden
 * vault included, and `assistant` is named even before it exists.
 */
export function appCredentialDenies(home: string, hash: string): string[] {
  const dc = join(home, '.dreamcontext');
  const apps = appsHome(home);
  return [
    ...credentialHomeDirs().filter((d) => d !== '.dreamcontext').map((d) => `Read(/${rulePath(join(home, d))}/**)`),
    ...CREDENTIAL_HOME_FILES.map((f) => `Read(/${rulePath(join(home, f))})`),
    `Read(/${rulePath(join(dc, 'assistant'))}/**)`,
    ...childRules(dc, new Set(['apps', 'assistant'])),
    ...childRules(apps, new Set(['data'])),
    ...childRules(join(apps, 'data'), new Set([hash])),
    ...[...CREDENTIAL_ANYWHERE, ...APP_CREDENTIAL_FILES].map((g) => `Read(//${g})`),
  ];
}

/** Root-anchored write denies: they outrank Allow, whatever a card or a project rule says. */
export function appWriteDenies(input: { projectRoot: string; appRoot: string; dataDir: string; home: string }): string[] {
  const paths = [
    `${input.projectRoot}/**`,
    join(input.appRoot, ROLE_FILE),
    join(input.appRoot, MANIFEST_FILE),
    `${input.appRoot}/.claude/**`,
    `${input.dataDir}/.claude/**`,
    `${appChatsDir(input.home)}/**`,
    registryPath(input.home),
  ];
  return paths.map((p) => rulePath(p)).flatMap((p) => [`Edit(/${p})`, `Write(/${p})`]);
}

/** The per-chat PreToolUse hook. Fails closed on everything it can see: a missing CLI, a non-zero
 *  exit, empty or noisy stdout all exit 2. Only a timeout stays open (R7). */
export function appBashGateHook(cli: readonly string[], gateFile: string): { PreToolUse: unknown[] } {
  const call = [...cli.map((c) => `"${c}"`), 'hook', 'app-bash-gate', `"${gateFile}"`].join(' ');
  const command = `o=$(${call}) || exit 2; case "$o" in '{'*'}') printf '%s' "$o";; *) exit 2;; esac`;
  return { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 30 }] }] };
}

/** The running CLI, absolute: node plus its entry, so a Finder-started server needs no PATH. */
export function ownCliCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const entry = env.DREAMCONTEXT_CLI || process.argv[1] || '';
  return [process.execPath, entry];
}

function ownBriefing(name: string, role: string): string {
  return [
    'APP ASSISTANT',
    `You are the assistant of the app "${name}", talking with its owner in the app's own window.`,
    'You are not an AI Team member: you have no thread and no agent page.',
    '',
    `--- YOUR ROLE (the app's ${ROLE_FILE}) ---`,
    role,
    '--- END ROLE ---',
  ].join('\n');
}

export interface AppChatEnvelope {
  slug: string;
  name: string;
  hash: string;
  appRoot: string;
  dataDir: string;
  /** The own assistant. False = a bound AI Team member. */
  own: boolean;
  member: string | null;
  briefing: string;
  permissionMode: string;
  allowed: string[];
  denied: string[];
  addDirs: string[];
  /** The own assistant's MCP subset, or null (a member keeps the chat's stores). */
  mcpConfig: string | null;
  /** Absent for a member: the normal setting sources apply. */
  settingSources: string | null;
  env: Record<string, string>;
  /** The Bash gate's hooks fragment; null for a member. */
  hooks: { PreToolUse: unknown[] } | null;
  dispose: () => void;
}

export type AppChatPrep = { ok: true; app: AppChatEnvelope } | { ok: false; reason: string };

const refuse = (reason: string): AppChatPrep => ({ ok: false, reason });

/** Rules ride the login-shell script in double quotes. */
const unsafeRule = (r: string): boolean => /[$`"\\!\n\r]/.test(r);

export function prepareAppChat(record: AppChatRecord, opts: { projectRoot: string; home?: string; cli?: string[] }): AppChatPrep {
  const home = opts.home ?? homedir();
  const projectRoot = real(opts.projectRoot);
  if (record.removedAt) return refuse('this app was removed');
  if (record.projectRoot !== projectRoot) return refuse('this conversation belongs to another project');
  const rec = getApp(home, projectRoot, record.slug);
  if (!rec || rec.hash !== record.hash) return refuse('this app is not registered any more');
  const m = readManifest(rec.root);
  if (!m.ok) return refuse(`its manifest is broken: ${m.errors.map((e) => `${e.field}: ${e.problem}`).join('; ')}`);
  const dataDir = appDataDir(home, rec.hash);
  const denied = [
    ...appDeniedTools(),
    ...appWriteDenies({ projectRoot, appRoot: rec.root, dataDir, home }),
    ...appCredentialDenies(home, rec.hash),
  ];
  const baseEnv = { [AGENT_CHAT_ENV]: `app-${rec.slug}` };
  const pathProblem = forbiddenPathReason('app', rec.root) ?? forbiddenPathReason('project', projectRoot);
  if (pathProblem) return refuse(pathProblem);

  if (record.member) {
    const contextRoot = join(projectRoot, '_dream_context');
    const target = getRunTarget(contextRoot, record.member, 'agent');
    if (!target) return refuse(`no agent named "${record.member}" in this project`);
    if (target.whiteboard) return refuse(`${record.member} is confined to a whiteboard`);
    const prep = prepareAgentChat(contextRoot, record.member, home, { excludeSession: record.id });
    if (!prep.ok) return refuse(prep.reason);
    const level = target.autonomy ?? DEFAULT_AGENT_AUTONOMY;
    const args = levelPermissionArgs(level === 'free' ? 'balanced' : level, 'chat');
    const permissionMode = args[args.indexOf('--permission-mode') + 1] ?? 'auto';
    const dangerDenies = m.manifest.actions.filter((a) => a.danger).map((a) => `Bash(dreamcontext apps do ${rec.slug} ${a.id}:*)`);
    const all = [...denied, 'Bash(dreamcontext apps call:*)', ...dangerDenies];
    if (all.some(unsafeRule)) { prep.dispose(); return refuse('its folders contain a character the shell would expand'); }
    return {
      ok: true,
      app: {
        slug: rec.slug, name: m.manifest.name, hash: rec.hash, appRoot: rec.root, dataDir, own: false, member: record.member,
        briefing: prep.briefing, permissionMode, allowed: [], denied: all, addDirs: [rec.root, dataDir], mcpConfig: null, settingSources: null,
        env: { ...prep.env, ...baseEnv }, hooks: null, dispose: prep.dispose,
      },
    };
  }

  const problem = roleFileProblem(rec.root);
  if (problem) return refuse(`${ROLE_FILE} is ${problem.problem}`);
  let role: string;
  try { role = sanitizeAutomationPrompt(readFileSync(join(rec.root, ROLE_FILE), 'utf-8')).trim().slice(0, ROLE_MAX_CHARS); } catch { return refuse(`${ROLE_FILE} cannot be read`); }

  // The hook line runs in bash (Git Bash on Windows), where a forward-slash `C:/...` is the same
  // file and a backslash would be an escape: the install path rides with forward slashes there.
  const cli = (opts.cli ?? ownCliCommand()).map((c) => (process.platform === 'win32' ? c.replace(/\\/g, '/') : c));
  if (!cli.every(Boolean)) return refuse('the dreamcontext install path is unknown');
  if (cli.some(unsafeRule)) return refuse('the dreamcontext install path is not shell-safe');
  const allowed = appAllowedTools({ slug: rec.slug, dataDir, actions: m.manifest.actions, readTools: m.manifest.agent?.readTools ?? [] });
  if ([...allowed, ...denied].some(unsafeRule)) return refuse('its folders contain a character the shell would expand');

  let mcpConfig: string | null = null;
  const context: BashGateContext = { slug: rec.slug, appRoot: rec.root, dataDir, actions: m.manifest.actions.filter((a) => !a.danger).map((a) => a.id) };
  const gateFile = gateFilePath(record.id, home);
  try {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(appChatsDir(home), { recursive: true, mode: 0o700 });
    if (existsSync(gateFile) && lstatSync(gateFile).isSymbolicLink()) return refuse('its gate file is a symlink');
    writeFileSync(gateFile, JSON.stringify(context), { encoding: 'utf-8', mode: 0o600 });
    const known = knownMcpServers(projectRoot, home);
    mcpConfig = writeLeanMcpConfig(m.manifest.mcp.filter((n) => known.has(n)), known);
  } catch (err) {
    return refuse(`its chat could not be prepared (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  // A Windows path carries backslashes by nature; it is judged in the slash form Claude reads.
  if (mcpConfig && unsafeRule(process.platform === 'win32' ? mcpConfig.replace(/\\/g, '/') : mcpConfig)) { removeLeanMcpConfig(mcpConfig); return refuse('its MCP config path is not shell-safe'); }
  return {
    ok: true,
    app: {
      slug: rec.slug, name: m.manifest.name, hash: rec.hash, appRoot: rec.root, dataDir, own: true, member: null,
      briefing: ownBriefing(cleanText(m.manifest.name, 60), role),
      permissionMode: 'default', allowed, denied, addDirs: [rec.root, dataDir], mcpConfig,
      settingSources: 'project', env: baseEnv, hooks: appBashGateHook(cli, process.platform === 'win32' ? gateFile.replace(/\\/g, '/') : gateFile),
      dispose: () => removeLeanMcpConfig(mcpConfig),
    },
  };
}

/**
 * The owner's own model and effort: `--setting-sources project` drops them, so they ride argv.
 * `configDir` is an account's: a sandbox holds `settings.json` itself, account #0 is the real HOME
 * with its `.claude/`. No file names no model, and the CLI's default stands.
 */
export function userChatDefaults(configDir: string): { model: string; effort: string } {
  const word = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9._[\]-]{1,60}$/.test(v) ? v : '');
  for (const file of [join(configDir, 'settings.json'), join(configDir, '.claude', 'settings.json')]) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
      return { model: word(raw.model), effort: word(raw.effortLevel) };
    } catch { /* the other home */ }
  }
  return { model: '', effort: '' };
}

// ─── how many chats an app runs at once ─────────────────────────────────────────────

/** Six at once are six SessionStart snapshots (R3); the seventh is refused, never queued. */
export const APP_CHAT_MAX_LIVE = 6;
const liveChats = new Map<string, Map<object, string>>();

function liveIds(hash: string): Set<string> {
  return new Set(liveChats.get(hash)?.values() ?? []);
}

/** May this conversation start a child now? One already running always may (a respawn). */
export function appChatHasRoom(hash: string, id: string): boolean {
  const ids = liveIds(hash);
  return ids.has(id) || ids.size < APP_CHAT_MAX_LIVE;
}

/** Taken right before the spawn, with nothing async since `appChatHasRoom`. Returns its release:
 *  the death of the key, called when the child exits. */
export function reserveAppChat(hash: string, id: string): () => void {
  const key = {};
  const held = liveChats.get(hash) ?? new Map<object, string>();
  held.set(key, id);
  liveChats.set(hash, held);
  return () => {
    held.delete(key);
    if (!held.size && liveChats.get(hash) === held) liveChats.delete(hash);
  };
}
