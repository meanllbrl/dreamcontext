/**
 * Claude's roles as Antigravity sub-agents: a plugin of ours in the account profile, under a fake
 * HOME only. The agent's loader wants `name` + `description` and refuses tool names it does not
 * know, so the file carries those two and nothing of Claude's harness.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import matter from 'gray-matter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { ANTIGRAVITY_PLUGIN, antigravityRoleMd, syncAntigravityRoles } from '../../src/lib/antigravity-roles.js';
import { CLAUDE_ONLY } from '../../src/lib/tool-text.js';
import { KIT_MAX_AGE_MS, refreshToolKits, toolKitsStampPath } from '../../src/lib/tool-kits-refresh.js';

const ROOT = resolve(import.meta.dirname, '../..');
const repo = (sub: string): string | null => join(ROOT, sub);
const agentMd = (name: string, body: string, extra = ''): string => `---\nname: ${name}\ndescription: >\n  The ${name}: of a fictional shop.\n\n  <example>\n  user: "go"\n  </example>\nmodel: opus\n${extra}---\n\n${body}\n`;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-roles-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const agentsDir = (id = 'primary') => join(antigravityProfileDir(id, home), 'config', 'plugins', ANTIGRAVITY_PLUGIN, 'agents');

describe('antigravityRoleMd', () => {
  it('keeps name and description only, opens with the brain, and speaks Antigravity', () => {
    const r = antigravityRoleMd(agentMd('cart-auditor', 'Audit. Use the Agent tool with subagent_type reviewer (Agent tool, model sonnet, effort low).', 'tools: Read, Grep, Bash\nskills:\n  - dreamcontext-agent-core\n'), { agentCore: '/pkg/skill-agent-core/SKILL.md' });
    expect(r).not.toBeNull();
    const fm = matter(r!.md);
    expect(Object.keys(fm.data).sort()).toEqual(['description', 'name']);
    expect(fm.data.name).toBe('cart-auditor');
    expect(fm.data.description).toBe('The cart-auditor: of a fictional shop.');
    expect(fm.content).toContain('dreamcontext snapshot');
    expect(fm.content).toContain('dreamcontext-agent-core (/pkg/skill-agent-core/SKILL.md)');
    expect(fm.content).toContain('it never edits a file');
    expect(fm.content).toContain('invoke_subagent with subagent_name reviewer');
    expect(CLAUDE_ONLY.test(fm.content)).toBe(false);
  });

  it('refuses the names the agent keeps, a bad name, and an empty body', () => {
    for (const n of ['self', 'research', 'browser', 'Bad Name']) expect(antigravityRoleMd(agentMd(n, 'x'))).toBeNull();
    expect(antigravityRoleMd('---\nname: empty\ndescription: d\n---\n\n')).toBeNull();
  });

  it('a writing role is not told it only reads', () => {
    expect(antigravityRoleMd(agentMd('fixer', 'Fix.', 'tools: Read, Edit, Bash\n'))!.md).not.toContain('never edits');
  });
});

describe('syncAntigravityRoles', () => {
  it('writes every shipped role and the owner\'s own into the account profile, the owner winning', () => {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'reviewer.md'), agentMd('reviewer', 'The owner reviewer.'));
    writeFileSync(join(home, '.claude', 'agents', 'self.md'), agentMd('self', 'Reserved.'));
    const r = syncAntigravityRoles('primary', { home, packageDir: repo });
    expect(r.ok).toBe(true);
    const names = r.ok ? r.names : [];
    // The core roles, goal, review and council included, are all there.
    for (const n of ['sleep-state', 'curator-worker', 'initializer-scout', 'dreamcontext-explore', 'goal-planner', 'goal-implementer', 'review-router', 'council-persona', 'reviewer']) expect(names).toContain(n);
    expect(names).not.toContain('self');
    const shipped = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(new Set(names)).toEqual(new Set(shipped));
    expect(readFileSync(join(agentsDir(), 'reviewer.md'), 'utf-8')).toContain('The owner reviewer.');
    const manifest = JSON.parse(readFileSync(join(agentsDir(), '..', 'plugin.json'), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(['description', 'name']);
    expect(manifest.name).toBe(ANTIGRAVITY_PLUGIN);
    for (const f of readdirSync(agentsDir())) {
      const fm = matter(readFileSync(join(agentsDir(), f), 'utf-8'));
      expect(typeof fm.data.name === 'string' && typeof fm.data.description === 'string', f).toBe(true);
      expect(CLAUDE_ONLY.test(fm.content), f).toBe(false);
    }
  });

  it('drops a role that went away, and replaces a planted link without following it', () => {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'shop-helper.md'), agentMd('shop-helper', 'Help.'));
    syncAntigravityRoles('primary', { home, packageDir: () => null });
    expect(existsSync(join(agentsDir(), 'shop-helper.md'))).toBe(true);
    rmSync(join(home, '.claude', 'agents', 'shop-helper.md'));
    syncAntigravityRoles('primary', { home, packageDir: () => null });
    expect(existsSync(join(agentsDir(), 'shop-helper.md'))).toBe(false);

    const outside = join(home, 'outside');
    mkdirSync(outside);
    rmSync(agentsDir(), { recursive: true });
    symlinkSync(outside, agentsDir(), 'dir');
    writeFileSync(join(home, '.claude', 'agents', 'shop-helper.md'), agentMd('shop-helper', 'Help.'));
    expect(syncAntigravityRoles('primary', { home, packageDir: () => null }).ok).toBe(true);
    expect(lstatSync(agentsDir()).isSymbolicLink()).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('refreshToolKits', () => {
  const project = () => {
    const p = join(home, 'acme-shop');
    mkdirSync(join(p, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(p, '.claude', 'agents', 'cart-auditor.md'), agentMd('cart-auditor', 'Audit.'));
    return p;
  };

  it('writes nothing for a tool never used on this Mac', () => {
    const r = refreshToolKits('0.40.0', [{ path: project(), version: '0.40.0' }], { home, packageDir: repo, accounts: () => ['primary'] });
    expect(r).toMatchObject({ ran: true, codexProjects: 0, antigravityAccounts: 0 });
    expect(existsSync(join(home, '.dreamcontext', 'codex'))).toBe(false);
    expect(existsSync(antigravityProfileDir('primary', home))).toBe(false);
  });

  it('refreshes the Codex kit per project and each Antigravity profile, then waits for a change', () => {
    const p = project();
    mkdirSync(join(home, '.codex'));
    mkdirSync(antigravityProfileDir('primary', home), { recursive: true });
    const deps = { home, packageDir: repo, accounts: () => ['primary', 'acct-missing'], now: 1_000 };
    const r = refreshToolKits('0.40.0', [{ path: p, version: '0.40.0' }], deps);
    expect(r).toMatchObject({ ran: true, codexProjects: 1, antigravityAccounts: 1, failures: [] });
    expect(existsSync(join(agentsDir(), 'sleep-state.md'))).toBe(true);
    expect(readdirSync(join(antigravityProfileDir('primary', home), 'config', 'skills'))).toContain('dreamcontext');
    const roles = readdirSync(join(home, '.dreamcontext', 'codex', 'roles'));
    expect(roles).toHaveLength(1);
    expect(readdirSync(join(home, '.dreamcontext', 'codex', 'roles', roles[0]!))).toContain('cart-auditor.toml');
    expect(existsSync(antigravityProfileDir('acct-missing', home))).toBe(false);
    expect(existsSync(toolKitsStampPath(home))).toBe(true);

    expect(refreshToolKits('0.40.0', [{ path: p, version: '0.40.0' }], { ...deps, now: 2_000 }).ran).toBe(false);
    expect(refreshToolKits('0.40.0', [{ path: p, version: '0.41.0' }], { ...deps, now: 2_000 }).ran).toBe(true);
    expect(refreshToolKits('0.41.0', [{ path: p, version: '0.41.0' }], { ...deps, now: 3_000 }).ran).toBe(true);
    expect(refreshToolKits('0.41.0', [{ path: p, version: '0.41.0' }], { ...deps, now: 3_000 + KIT_MAX_AGE_MS }).ran).toBe(true);
  });
});
