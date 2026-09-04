/**
 * `claude-account-sandbox.ts` — the per-account `CLAUDE_CONFIG_DIR` directory.
 *
 * Three things are worth a test file here, and all three were real findings during planning:
 *   1. ACCOUNT #0 SHORT-CIRCUITS. Read without it, the reconciliation policy would refuse
 *      every ordinary spawn, because the real HOME's `projects/` really is a directory and
 *      not a symlink. That is the majority path, so it is the first test.
 *   2. NO MCP CONFIGURATION IS EVER COPIED, at either level. Measured on a real machine, 6 of
 *      27 trusted project entries carry their own non-empty `mcpServers`, so "the trust map
 *      holds no credentials" was a false statement about a secret. Seeding is a whitelist.
 *   3. A REAL FILE where a shared symlink belongs FAILS LOUDLY — neither skipped (which would
 *      strand the account in its own transcript store) nor overwritten (which would destroy
 *      whatever accumulated there).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSharedMcpConfig,
  FORBIDDEN_SANDBOX_KEYS,
  SHARED_SANDBOX_ENTRIES,
  SandboxError,
  buildSeedConfig,
  ensureSandbox,
  sandboxHasIdentity,
} from '../../src/lib/claude-account-sandbox.js';
import { sandboxDirFor } from '../../src/lib/claude-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-sandbox-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

const SANDBOX = sandboxDirFor('second-account', HOME);
const REAL_CLAUDE = join(HOME, '.claude');

/**
 * A real `~/.claude.json`, shaped like the live one — including the per-project MCP servers
 * that the measurement found, so the leak assertions below test something real.
 */
function realConfig(): Record<string, unknown> {
  return {
    oauthAccount: { accountUuid: 'uuid-a', emailAddress: 'a@example.com', organizationUuid: 'org-a' },
    machineID: 'machine-secret',
    numStartups: 812,
    hasCompletedOnboarding: true,
    hasTrustDialogAccepted: true,
    cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'uuid-a', utilization: {} },
    mcpServers: { 'top-level-server': { command: 'x', env: { TOKEN: 'top-secret-token' } } },
    projects: {
      '/Users/someone/projects/alpha': {
        allowedTools: ['Bash(ls:*)'],
        hasTrustDialogAccepted: true,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
        history: [{ display: 'a prompt the user typed' }],
        // The finding: a per-project MCP server, with its own secret.
        mcpServers: { 'project-server': { command: 'y', env: { API_KEY: 'per-project-secret' } } },
        mcpContextUris: ['ctx://alpha'],
        enabledMcpjsonServers: ['alpha-json'],
        disabledMcpjsonServers: [],
      },
      '/Users/someone/projects/beta': { hasTrustDialogAccepted: true },
    },
  };
}

function writeRealHome(): void {
  mkdirSync(REAL_CLAUDE, { recursive: true });
  writeFileSync(join(HOME, '.claude.json'), JSON.stringify(realConfig()), 'utf-8');
  for (const entry of SHARED_SANDBOX_ENTRIES) {
    const target = join(REAL_CLAUDE, entry);
    if (entry.includes('.')) writeFileSync(target, '', 'utf-8');
    else mkdirSync(target, { recursive: true });
  }
}

beforeEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(REAL_CLAUDE, { recursive: true, force: true });
  rmSync(join(HOME, '.claude.json'), { force: true });
  writeRealHome();
});

// ─── 1. Account #0 ────────────────────────────────────────────────────────────

describe('account #0 short-circuits the whole machine', () => {
  it('returns immediately having done NOTHING when the dir is the real HOME', () => {
    const before = readFileSync(join(HOME, '.claude.json'), 'utf-8');
    const res = ensureSandbox(HOME, HOME);

    expect(res.configDir).toBe(HOME);
    expect(res.created).toBe(false);
    // Nothing was laid, nothing was rewritten, nothing was refused.
    expect(readFileSync(join(HOME, '.claude.json'), 'utf-8')).toBe(before);
    expect(lstatSync(join(REAL_CLAUDE, 'projects')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(HOME, '.dreamcontext', 'claude-accounts'))).toBe(false);
  });

  it('does not refuse the ordinary spawn even though HOME\'s projects/ is a REAL directory', () => {
    // This is the bug the short-circuit exists to prevent: read literally, the
    // reconciliation policy's `real-file` branch would reject every normal spawn.
    expect(() => ensureSandbox(HOME, HOME)).not.toThrow();
  });

  it('reports account #0 as always having an identity', () => {
    expect(sandboxHasIdentity(HOME, HOME)).toBe(true);
  });
});

// ─── 2. Seeding is a whitelist ────────────────────────────────────────────────

describe('the seed is a WHITELIST — no MCP configuration is ever copied', () => {
  it('carries only the whitelisted top-level keys', () => {
    const seed = buildSeedConfig(realConfig());
    expect(Object.keys(seed).sort()).toEqual(['hasCompletedOnboarding', 'hasTrustDialogAccepted', 'projects']);
    // Identity and usage belong to the ACCOUNT, not to the seed.
    expect(seed).not.toHaveProperty('oauthAccount');
    expect(seed).not.toHaveProperty('cachedUsageUtilization');
    expect(seed).not.toHaveProperty('machineID');
  });

  it('rebuilds each project entry from the whitelist, dropping its MCP keys and history', () => {
    const seed = buildSeedConfig(realConfig());
    const alpha = (seed.projects as Record<string, Record<string, unknown>>)['/Users/someone/projects/alpha']!;
    expect(Object.keys(alpha).sort()).toEqual([
      'allowedTools',
      'hasClaudeMdExternalIncludesApproved',
      'hasClaudeMdExternalIncludesWarningShown',
      'hasTrustDialogAccepted',
    ]);
    expect(alpha).not.toHaveProperty('history');
  });

  it('the serialized seed contains NO forbidden key at ANY depth, and no secret', () => {
    const body = JSON.stringify(buildSeedConfig(realConfig()));
    for (const key of FORBIDDEN_SANDBOX_KEYS) {
      expect(body, `"${key}" reached the sandbox seed`).not.toContain(key);
    }
    for (const secret of ['top-secret-token', 'per-project-secret', 'machine-secret', 'uuid-a']) {
      expect(body, `"${secret}" reached the sandbox seed`).not.toContain(secret);
    }
  });

  it('the seed WRITTEN TO DISK contains no forbidden key either', () => {
    ensureSandbox(SANDBOX, HOME);
    const written = readFileSync(join(SANDBOX, '.claude.json'), 'utf-8');
    for (const key of FORBIDDEN_SANDBOX_KEYS) {
      expect(written, `"${key}" reached the sandbox on disk`).not.toContain(key);
    }
  });

  it('an absent or hostile real config yields an empty seed rather than throwing', () => {
    expect(buildSeedConfig(null)).toEqual({});
    expect(buildSeedConfig('nope')).toEqual({});
    expect(buildSeedConfig({ projects: [1, 2, 3] })).toEqual({});
  });
});

describe('the isolated `.claude.json` is CREATE-ONCE and 0600', () => {
  it('is written 0600 on creation', () => {
    ensureSandbox(SANDBOX, HOME);
    expect(statSync(join(SANDBOX, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it('is NOT rewritten on a later call — the account\'s identity and usage cache survive', () => {
    ensureSandbox(SANDBOX, HOME);
    const isolated = join(SANDBOX, '.claude.json');
    // Simulate the CLI having signed this sandbox in and cached its usage.
    writeFileSync(isolated, JSON.stringify({
      oauthAccount: { accountUuid: 'uuid-b' },
      cachedUsageUtilization: { fetchedAtMs: 999, accountUuid: 'uuid-b' },
    }), 'utf-8');

    ensureSandbox(SANDBOX, HOME);

    const after = JSON.parse(readFileSync(isolated, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(after.oauthAccount!.accountUuid).toBe('uuid-b');
    expect(after.cachedUsageUtilization!.fetchedAtMs).toBe(999);
  });

  it('pulls a widened mode back to 0600 without touching the content (drift detector)', () => {
    ensureSandbox(SANDBOX, HOME);
    const isolated = join(SANDBOX, '.claude.json');
    writeFileSync(isolated, '{"oauthAccount":{"accountUuid":"uuid-b"}}', 'utf-8');
    chmodSync(isolated, 0o644);

    ensureSandbox(SANDBOX, HOME);

    expect(statSync(isolated).mode & 0o777).toBe(0o600);
    expect(readFileSync(isolated, 'utf-8')).toBe('{"oauthAccount":{"accountUuid":"uuid-b"}}');
  });
});

// ─── 3. Reconciliation, all four states ───────────────────────────────────────

describe('reconciliation — the four states a shared path can be in', () => {
  it('MISSING: every shared entry is laid as a symlink into the real ~/.claude/', () => {
    ensureSandbox(SANDBOX, HOME);
    for (const entry of SHARED_SANDBOX_ENTRIES) {
      const link = join(SANDBOX, entry);
      expect(lstatSync(link).isSymbolicLink(), `${entry} is not a symlink`).toBe(true);
      expect(readlinkSync(link)).toBe(join(REAL_CLAUDE, entry));
    }
  });

  it('CORRECT: a second call is a no-op and does not relay anything', () => {
    ensureSandbox(SANDBOX, HOME);
    const before = lstatSync(join(SANDBOX, 'projects')).ino;
    ensureSandbox(SANDBOX, HOME);
    expect(lstatSync(join(SANDBOX, 'projects')).ino).toBe(before);
  });

  it('WRONG TARGET: a symlink pointing somewhere else is relaid', () => {
    mkdirSync(SANDBOX, { recursive: true });
    const elsewhere = join(HOME, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(SANDBOX, 'projects'), 'dir');

    ensureSandbox(SANDBOX, HOME);

    expect(readlinkSync(join(SANDBOX, 'projects'))).toBe(join(REAL_CLAUDE, 'projects'));
  });

  it('DANGLING: the target is recreated, then the link is relaid', () => {
    ensureSandbox(SANDBOX, HOME);
    // The whole real store disappears (e.g. ~/.claude wiped).
    rmSync(REAL_CLAUDE, { recursive: true, force: true });
    expect(existsSync(join(SANDBOX, 'projects'))).toBe(false); // dangling

    ensureSandbox(SANDBOX, HOME);

    expect(existsSync(join(REAL_CLAUDE, 'projects'))).toBe(true);
    expect(existsSync(join(SANDBOX, 'projects'))).toBe(true);
    expect(readlinkSync(join(SANDBOX, 'projects'))).toBe(join(REAL_CLAUDE, 'projects'));
  });

  it('REAL FILE: fails LOUDLY, names the path, and changes nothing', () => {
    mkdirSync(join(SANDBOX, 'projects'), { recursive: true });
    writeFileSync(join(SANDBOX, 'projects', 'stranded.jsonl'), 'accumulated while the link was broken', 'utf-8');

    expect(() => ensureSandbox(SANDBOX, HOME)).toThrow(SandboxError);
    expect(() => ensureSandbox(SANDBOX, HOME)).toThrow(/projects/);

    // Neither skipped nor overwritten: what was there is still there.
    expect(readFileSync(join(SANDBOX, 'projects', 'stranded.jsonl'), 'utf-8'))
      .toBe('accumulated while the link was broken');
  });
});

describe('the MCP config is shared BY REFERENCE — one 0600 file, never N copies', () => {
  it('writes the top-level mcpServers to one file, 0600, and returns its path', () => {
    const path = ensureSharedMcpConfig(HOME);
    expect(path).toBe(join(HOME, '.dreamcontext', 'claude-accounts', 'mcp-config.json'));
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(path!, 'utf-8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers)).toEqual(['top-level-server']);
  });

  it('carries ONLY the top-level map — a per-project server is left behind', () => {
    const written = readFileSync(ensureSharedMcpConfig(HOME)!, 'utf-8');
    // The per-project server and its secret belong to a `projects[<path>]` entry whose trust
    // state is seeded by whitelist; it is not part of the shared reference.
    expect(written).not.toContain('project-server');
    expect(written).not.toContain('per-project-secret');
  });

  it('is REWRITTEN when the source changes, so a newly added server reaches the sandboxes', () => {
    ensureSharedMcpConfig(HOME);
    const blob = realConfig();
    (blob.mcpServers as Record<string, unknown>)['a-new-server'] = { command: 'z' };
    writeFileSync(join(HOME, '.claude.json'), JSON.stringify(blob), 'utf-8');

    const written = readFileSync(ensureSharedMcpConfig(HOME)!, 'utf-8');
    expect(written).toContain('a-new-server');
  });

  it('returns null when there is nothing to share, so no empty flag is passed', () => {
    writeFileSync(join(HOME, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }), 'utf-8');
    expect(ensureSharedMcpConfig(HOME)).toBeNull();
    writeFileSync(join(HOME, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
    expect(ensureSharedMcpConfig(HOME)).toBeNull();
  });

  it('never throws on an absent or malformed real config', () => {
    rmSync(join(HOME, '.claude.json'), { force: true });
    expect(() => ensureSharedMcpConfig(HOME)).not.toThrow();
    expect(ensureSharedMcpConfig(HOME)).toBeNull();
    writeFileSync(join(HOME, '.claude.json'), '{ not json', 'utf-8');
    expect(ensureSharedMcpConfig(HOME)).toBeNull();
  });
});

describe('ensureSandbox is called before EVERY spawn, so it must self-heal', () => {
  it('repairs a symlink broken long after creation', () => {
    ensureSandbox(SANDBOX, HOME);
    rmSync(join(SANDBOX, 'projects'), { force: true });   // someone deleted the link

    ensureSandbox(SANDBOX, HOME);

    // Had this only run at creation time, the CLI would open a REAL projects/ here and the
    // transcript split would come back silently.
    expect(lstatSync(join(SANDBOX, 'projects')).isSymbolicLink()).toBe(true);
  });

  it('recreates and reseeds a sandbox deleted by hand — but its IDENTITY is gone', () => {
    ensureSandbox(SANDBOX, HOME);
    writeFileSync(join(SANDBOX, '.claude.json'), '{"oauthAccount":{"accountUuid":"uuid-b"}}', 'utf-8');
    expect(sandboxHasIdentity(SANDBOX, HOME)).toBe(true);

    rmSync(SANDBOX, { recursive: true, force: true });
    const res = ensureSandbox(SANDBOX, HOME);

    expect(res.created).toBe(true);
    expect(existsSync(join(SANDBOX, '.claude.json'))).toBe(true);
    // Not an ordinary "signed out" — a distinct needs-relogin state the UI must name.
    expect(sandboxHasIdentity(SANDBOX, HOME)).toBe(false);
  });

  it('refuses a config dir outside the sandbox root', () => {
    expect(() => ensureSandbox('/tmp/not-a-sandbox', HOME)).toThrow(/outside the account sandbox root/);
  });
});
