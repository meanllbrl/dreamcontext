/**
 * A team's tool envelope (plan C4). Invariant: a team's tools are exactly the design whose hash
 * the owner pressed, and nothing it loads from disk; it writes only its workspace; it reaches no
 * network; team-authored code runs only inside the OS sandbox.
 *
 * Claude: every turn starts with `--setting-sources ''` (no user, project or local settings, so a
 * hook a team writes into `repo/.claude/` never loads), `--strict-mcp-config` with only the
 * design's servers, `--tools` = {@link TEAM_BUILTIN_TOOLS}, `--disallowedTools` =
 * {@link teamDeniedTools} plus the path denies, and one `--settings` file holding the sandbox
 * (network: no domain, no local binding) and the deny rules. Passed again on every resumed turn.
 *
 * Codex: the `hackathon-team` envelope row (`auto`, writable roots = repo + out, network and web
 * search off, every listed server switched off through `codexStrictArgs`); a null there refuses.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertNotAppChat } from '../apps/chat-store.js';
import { absRule } from '../automations/board-scope.js';
import { LIGHT_DISALLOWED_TOOLS } from '../automations/light-run.js';
import { codexStrictArgs, type CodexListedServer } from '../t3-bridge/launch.js';
import type { Design, TeamDesign } from './designer.js';
import { conductorDir, runWorkspace, teamWorkspace } from './run-store.js';
import { teamEnv, teamReadDenies } from './secrets.js';

/** The built-in tools a Claude team has: an allowlist (`--tools`), never a hand-written deny. */
export const TEAM_BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Agent', 'Task', 'TodoWrite'] as const;

/**
 * Derived from the light job's list minus the team's own tools (as `appDeniedTools` derives its
 * list), so every tool that reaches past the machine or takes no permission stays closed and
 * cannot drift: MCP resource readers, SendMessage, RemoteTrigger, PushNotification, Cron*, Skill,
 * WebFetch, WebSearch, AskUserQuestion. `hackathon-team-session.test.ts` pins it.
 */
export function teamDeniedTools(): string[] {
  const own = new Set<string>(TEAM_BUILTIN_TOOLS);
  return LIGHT_DISALLOWED_TOOLS.filter((t) => !own.has(t));
}

export interface TeamPaths {
  repo: string;
  out: string;
  /** The brain's project root (read-only for the team). */
  brainRoot: string;
  /** Linked repos' main checkouts (read-only). */
  linkedRepos: readonly string[];
  home: string;
  /** Rival teams' workspace roots. */
  rivals: readonly string[];
  conductor: string;
  /** The brain's `_dream_context/hackathon` folder (team folders, other teams' transcripts). */
  brainHackathon: string;
}

export function teamPaths(input: { runId: string; team: string; design: Design; brainRoot: string; linkedRepos: readonly string[]; home?: string; wsHome?: string }): TeamPaths {
  const ws = teamWorkspace(input.runId, input.team, input.wsHome);
  return {
    repo: ws.repo,
    out: ws.out,
    brainRoot: input.brainRoot,
    linkedRepos: input.linkedRepos,
    home: input.home ?? homedir(),
    rivals: input.design.teams.filter((t) => t.id !== input.team).map((t) => teamWorkspace(input.runId, t.id, input.wsHome).root),
    conductor: conductorDir(input.runId, input.wsHome),
    brainHackathon: join(input.brainRoot, '_dream_context', 'hackathon'),
  };
}

/**
 * Command-prefix denies. They only stop a DIRECT call: the W1 proof found the sandbox lets
 * `security` reach the login Keychain, and an interpreter (`python3 -c`, `node -e`, `sh -c`) gets
 * past a prefix. So no team is read-isolated from the Keychain ({@link teamReadIsolated}), the
 * card says so, and the PR scan looks for the token's value plain and encoded (apply.ts).
 */
export const TEAM_BASH_DENIES = ['Bash(security:*)', 'Bash(/usr/bin/security:*)', 'Bash(gh:*)', 'Bash(osascript:*)', 'Bash(open:*)'] as const;

/** Write denies: everything the team can reach that is not its workspace. */
/**
 * Whether a team's reads are closed at the OS boundary. False for every tool: Claude's sandbox
 * leaves the Keychain service reachable (W1) and Codex reads the whole disk. The start card and
 * the stats read this, never a per-tool guess.
 */
export function teamReadIsolated(_t: Pick<TeamDesign, 'tool'>): boolean {
  return false;
}

export function teamWriteDenies(p: TeamPaths): string[] {
  const roots = [p.brainRoot, ...p.linkedRepos, join(p.home, '.dreamcontext'), join(p.home, '.claude'), join(p.home, '.codex'), ...p.rivals, p.conductor];
  return roots.flatMap((r) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((tool) => absRule(tool, r)));
}

/** Read denies: the secrets inventory plus rivals, brain team folders and the conductor's dir. */
export function teamReadDenyRules(p: TeamPaths): string[] {
  return teamReadDenies(p.home, [...p.rivals, p.conductor, p.brainHackathon]);
}

/** The one `--settings` file: sandbox (no network at all), deny rules, the second-layer hook. */
export function teamSettings(p: TeamPaths, hookCommand: string | null): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: 'acceptEdits',
      deny: [...teamWriteDenies(p), ...teamReadDenyRules(p), ...teamDeniedTools(), ...TEAM_BASH_DENIES],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    },
    ...(hookCommand ? { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }] } } : {}),
  };
}

/** The roles as `--agents`: Yapıcı builds, Eleştirmen objects. A solo team has none. */
export function teamAgents(t: TeamDesign): Record<string, { description: string; prompt: string; tools: string[] }> | null {
  if (t.inner === 'solo') return null;
  return {
    yapici: {
      description: 'Yapıcı: builds what the Kaptan decided, in repo/, and reports what changed.',
      prompt: `You are the Yapıcı (builder) of team ${t.name}. Build exactly what the Kaptan's decision says, inside the repo. Report the files you changed and how you checked them.`,
      tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'Bash', 'TodoWrite'],
    },
    elestirmen: {
      description: 'Eleştirmen: reads the plan or the work and raises the one strongest objection.',
      prompt: `You are the Eleştirmen (critic) of team ${t.name}. Read the plan or the change and give the ONE strongest objection, with the evidence. Never edit files.`,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    },
  };
}

export interface ClaudeTurnInput {
  team: TeamDesign;
  paths: TeamPaths;
  design: Design;
  prompt: string;
  sessionId: string;
  resume: boolean;
  /** Where the conductor keeps this team's settings and MCP config (conductor-owned). */
  configDir: string;
  /** The MCP servers the design's tools belong to, as `mcpServers` entries. */
  mcpServers?: Record<string, unknown>;
  hookCommand?: string | null;
}

/** The servers named by the design's literal `mcp__server__tool` names. */
export function serversOf(tools: readonly string[]): string[] {
  return [...new Set(tools.map((t) => /^mcp__([A-Za-z0-9_-]+?)__/.exec(t)?.[1]).filter((s): s is string => !!s))];
}

/**
 * The whole argv of one Claude team turn, after the binary. Writes the settings and MCP files
 * into `configDir` (conductor-owned). Identical on every resumed turn.
 */
export function claudeTeamArgv(i: ClaudeTurnInput): string[] {
  mkdirSync(i.configDir, { recursive: true });
  const settingsFile = join(i.configDir, `${i.team.id}.settings.json`);
  const mcpFile = join(i.configDir, `${i.team.id}.mcp.json`);
  writeFileSync(settingsFile, `${JSON.stringify(teamSettings(i.paths, i.hookCommand ?? null), null, 2)}\n`);
  const wanted = new Set(serversOf(i.design.mcpTools));
  const servers = Object.fromEntries(Object.entries(i.mcpServers ?? {}).filter(([k]) => wanted.has(k)));
  writeFileSync(mcpFile, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  const tools = i.design.mcpTools.filter((t) => wanted.has(serversOf([t])[0] ?? '') && (serversOf([t])[0]! in servers));
  const agents = teamAgents(i.team);
  return [
    ...(i.resume ? ['--resume', assertNotAppChat(i.sessionId)] : ['--session-id', i.sessionId]),
    '--model', i.team.model,
    '--setting-sources', '',
    '--strict-mcp-config', '--mcp-config', mcpFile,
    '--settings', settingsFile,
    '--permission-mode', 'acceptEdits',
    // The brain and linked repos are working directories so Bash may `cd` there to run recall
    // (a cd outside them asks, and a headless ask is a denial); their writes stay denied by rule,
    // which the sandbox applies to Bash too (W1 proof).
    '--add-dir', i.paths.out, i.paths.brainRoot, ...i.paths.linkedRepos,
    '--tools', TEAM_BUILTIN_TOOLS.join(','),
    // Reading the brain and linked repos needs no prompt (a headless prompt is a denial);
    // the deny rules in the settings file outrank this allow.
    '--allowedTools', 'Read', 'Grep', 'Glob', ...tools,
    '--disallowedTools', ...teamDeniedTools(),
    ...(agents ? ['--agents', JSON.stringify(agents)] : []),
    '--output-format', 'stream-json', '--verbose',
    '-p', i.prompt,
  ];
}

/** A team process's environment: the allowlist only, plus the run's marker for the hook. */
export function claudeTeamEnv(base: NodeJS.ProcessEnv, runId: string, team: string): NodeJS.ProcessEnv {
  return { ...teamEnv(base, 'claude'), DREAMCONTEXT_HACKATHON_TEAM: `${runId}/${team}` };
}

// ─── Codex ──────────────────────────────────────────────────────────────────

export interface CodexTurnPlan {
  ok: true;
  cwd: string;
  writableRoots: string[];
  configArgs: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The Codex team's turn, or the refusal: `codexStrictArgs(listed, [])` must switch off every
 * server Codex lists from `repo/`, and a server not seen at start refuses the turn.
 */
export function codexTeamTurn(input: {
  paths: TeamPaths;
  listed: readonly CodexListedServer[] | null;
  seenAtStart: readonly string[] | null;
  base: NodeJS.ProcessEnv;
}): CodexTurnPlan | { ok: false; reason: string } {
  const strict = codexStrictArgs(input.listed, []);
  if (strict == null) return { ok: false, reason: 'Codex MCP sunucuları kapatılamadı: Codex ekibi çalıştırılmadı' };
  if (input.seenAtStart && input.listed) {
    const fresh = input.listed.filter((s) => !input.seenAtStart!.includes(s.name)).map((s) => s.name);
    if (fresh.length) return { ok: false, reason: `başlangıçta olmayan Codex sunucusu: ${fresh.join(', ')}` };
  }
  return { ok: true, cwd: input.paths.repo, writableRoots: [input.paths.repo, input.paths.out], configArgs: strict, env: teamEnv(input.base, 'codex') };
}

/** Antigravity has no OS sandbox: refused, with its reason. */
export const ANTIGRAVITY_REFUSAL = 'Antigravity ekipleri desteklenmiyor: işletim sistemi kum havuzu yok, yazma ve ağ sınırlanamaz.';

export function workspaceRootOf(runId: string, wsHome?: string): string {
  return runWorkspace(runId, wsHome);
}
