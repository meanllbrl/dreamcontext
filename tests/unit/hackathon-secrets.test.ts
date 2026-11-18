/**
 * Hackathon criteria 7 (envelope half, the parts a unit test can pin) and 13: the team boundary is
 * built from one secrets inventory. Drift tests: every deny pattern has a value reader or a "not
 * scannable" reason, and `teamDeniedTools()` keeps every light-job deny that is not a team tool.
 * The real-process proof is `tests/integration/hackathon-team-boundary.test.ts` (env-gated).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIGHT_DISALLOWED_TOOLS } from '../../src/lib/automations/light-run.js';
import {
  DENY_SOURCES, denyPatterns, isKeyFilePath, knownSecretValues, secretReaders, teamEnv, teamReadDenies, TEAM_ENV_ALLOW,
} from '../../src/lib/hackathon/secrets.js';
import {
  ANTIGRAVITY_REFUSAL, TEAM_BASH_DENIES, TEAM_BUILTIN_TOOLS, claudeTeamArgv, claudeTeamEnv, codexTeamTurn, teamDeniedTools, teamPaths, teamSettings,
} from '../../src/lib/hackathon/team-session.js';
import { validateDesign } from '../../src/lib/hackathon/designer.js';
import { HACKATHON_GITIGNORE, workspaceHome } from '../../src/lib/hackathon/run-store.js';

const design = validateDesign({
  kind: 'plan', problem: 'Deney', target: '/repo',
  teams: [{ id: 'a', tool: 'claude', model: 'sonnet' }, { id: 'b', tool: 'claude', inner: 'solo' }],
  mcpTools: ['mcp__posthog__insights-get'],
}, { codexUsable: false }).design;

describe('inventory drift', () => {
  it('every deny pattern has a reader or a not-scannable reason', () => {
    const readers = secretReaders({ contextRoot: '/nope', repoRoots: [], ghToken: () => null, keychainToken: () => null });
    const covered = new Set(DENY_SOURCES.map((s) => s.pattern));
    for (const p of denyPatterns()) expect(covered.has(p), `${p} has no DENY_SOURCES row`).toBe(true);
    for (const s of DENY_SOURCES) {
      if ('reader' in s) expect(readers[s.reader], `${s.pattern} reader ${s.reader}`).toBeTypeOf('function');
      else expect(s.notScannable.length).toBeGreaterThan(0);
    }
  });
  it('teamDeniedTools keeps every light deny that is not a team tool', () => {
    const own = new Set<string>(TEAM_BUILTIN_TOOLS);
    const denied = new Set(teamDeniedTools());
    for (const t of LIGHT_DISALLOWED_TOOLS) if (!own.has(t)) expect(denied.has(t), t).toBe(true);
    for (const t of ['WebFetch', 'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'RemoteTrigger', 'PushNotification', 'SendMessage']) {
      expect(denied.has(t), t).toBe(true);
    }
  });
});

describe('team envelope', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hk-env-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const paths = () => teamPaths({ runId: '20261118-x', team: 'a', design, brainRoot: join(root, 'brain'), linkedRepos: [join(root, 'linked')], home: join(root, 'home'), wsHome: join(root, 'ws') });

  it('workspaces live under ~/.dreamcontext-hackathon by default', () => {
    expect(workspaceHome(join(root, 'h') + '/.dreamcontext-hackathon')).toMatch(/\.dreamcontext-hackathon$/);
    const p = paths();
    expect(p.repo.startsWith(join(root, 'ws'))).toBe(true);
    expect(p.rivals).toEqual([join(root, 'ws', '20261118-x', 'b')]);
  });
  it('denies writes to the brain, linked repos, rivals, the conductor and ~/.dreamcontext', () => {
    const deny = (teamSettings(paths(), null).permissions as { deny: string[] }).deny;
    for (const d of [join(root, 'brain'), join(root, 'linked'), join(root, 'ws', '20261118-x', 'b'), join(root, 'home', '.dreamcontext')]) {
      expect(deny.some((r) => r.startsWith('Write(') && r.includes(d)), d).toBe(true);
    }
    expect(deny.some((r) => r.startsWith('Read(') && r.includes('.conductor'))).toBe(true);
    for (const b of TEAM_BASH_DENIES) expect(deny).toContain(b);
  });
  it('the sandbox has no network at all', () => {
    const s = teamSettings(paths(), null).sandbox as { enabled: boolean; allowUnsandboxedCommands: boolean; network: { allowedDomains: string[]; allowLocalBinding: boolean } };
    expect(s.enabled).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.network.allowedDomains).toEqual([]);
    expect(s.network.allowLocalBinding).toBe(false);
  });
  it('reads denies cover .env, lab credentials, .secrets.json, .mcp.json and the recall key', () => {
    const rules = teamReadDenies(join(root, 'home'));
    for (const w of ['.env', 'credentials.json', '.secrets.json', '.mcp.json', 'recall-cloud.json']) expect(rules.some((r) => r.includes(w)), w).toBe(true);
  });
  it('argv: no user settings, strict MCP, built-in allowlist, the same tools on every resumed turn', () => {
    const team = design.teams[0]!;
    const mk = (resume: boolean) => claudeTeamArgv({ team, paths: paths(), design, prompt: 'p', sessionId: 's', resume, configDir: join(root, 'cfg'), mcpServers: { posthog: { command: 'x' }, other: { command: 'y' } } });
    const first = mk(false);
    const again = mk(true);
    for (const argv of [first, again]) {
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('');
      expect(argv).toContain('--strict-mcp-config');
      expect(argv[argv.indexOf('--tools') + 1]).toBe(TEAM_BUILTIN_TOOLS.join(','));
      expect(argv).toContain('mcp__posthog__insights-get');
    }
    expect(first.slice(first.indexOf('--tools'))).toEqual(again.slice(again.indexOf('--tools')));
    const mcp = JSON.parse(readFileSync(join(root, 'cfg', 'a.mcp.json'), 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['posthog']);
  });
  it('the team environment is an allowlist: no API keys or tokens', () => {
    const env = claudeTeamEnv({ PATH: '/bin', HOME: '/h', OPENROUTER_API_KEY: 'sk-or-1', GITHUB_TOKEN: 'ghp_x', CLAUDE_CONFIG_DIR: '/c' }, 'r', 'a');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
    expect(Object.keys(teamEnv({ PATH: '/bin', SECRET: 'x' }))).toEqual(['PATH']);
    expect(TEAM_ENV_ALLOW).not.toContain('GITHUB_TOKEN');
  });
  it('Codex is refused when its servers cannot be switched off; Antigravity is refused with a reason', () => {
    const r = codexTeamTurn({ paths: paths(), listed: null, seenAtStart: null, base: {} });
    expect(r.ok).toBe(false);
    expect(ANTIGRAVITY_REFUSAL).toMatch(/kum havuzu/);
  });
  it('a Codex turn writes only repo/ and out/', () => {
    const r = codexTeamTurn({ paths: paths(), listed: [], seenAtStart: [], base: { PATH: '/bin', OPENAI_API_KEY: 'x' } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.writableRoots).toEqual([paths().repo, paths().out]);
    expect(r.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('known secret values', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hk-sec-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('reads lab credentials and .env values, skips plain words', () => {
    const ctx = join(root, '_dream_context');
    mkdirSync(join(ctx, 'lab'), { recursive: true });
    writeFileSync(join(ctx, 'lab', 'credentials.json'), JSON.stringify({ posthog: 'phx_9fQ2kLmN0pQr' }));
    writeFileSync(join(root, '.env'), 'API_KEY=abc123def456ghi\nMODE=enabled\n');
    const vals = knownSecretValues({ contextRoot: ctx, repoRoots: [root], home: join(root, 'home'), env: {}, ghToken: () => 'gho_tokenvalue123', keychainToken: () => null });
    expect(vals).toContain('phx_9fQ2kLmN0pQr');
    expect(vals).toContain('abc123def456ghi');
    expect(vals).toContain('gho_tokenvalue123');
    expect(vals).not.toContain('enabled');
  });
  it('matches key files by path', () => {
    expect(isKeyFilePath('a/b/id_ed25519')).toBe(true);
    expect(isKeyFilePath('x/server.pem')).toBe(true);
    expect(isKeyFilePath('src/app.ts')).toBe(false);
  });
});

describe('gitignore', () => {
  it('brain team folders, kept work, media and round records stay local', () => {
    for (const g of ['*/teams/', '*/kept/', '*/media/', '*/rounds/', '*/brief.md']) expect(HACKATHON_GITIGNORE).toContain(g);
  });
});
