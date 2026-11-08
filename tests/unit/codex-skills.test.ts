/**
 * What a Codex chat reads, laid out under a fake HOME only: our skills (rewritten), the project's
 * and the owner's Claude skills by link, Claude's agents as Codex roles. Nothing is written in the
 * project or in `~/.codex`, and the app-server is told the roots right after `initialized`.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as Effect from 'effect/Effect';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRoleArgs, prepareCodexKit, roleToml } from '../../src/lib/codex-skills.js';
import { withSkillRoots, type ClientFactory } from '../../src/lib/t3-bridge/session.js';

const ROOT = resolve(import.meta.dirname, '../..');
const repo = (sub: string): string | null => join(ROOT, sub);

/** TOML basic strings are JSON strings, so a role file reads back line by line. */
const readToml = (file: string): Record<string, string> => Object.fromEntries(
  readFileSync(file, 'utf-8').trim().split('\n').map((l) => { const i = l.indexOf(' = '); return [l.slice(0, i), JSON.parse(l.slice(i + 3)) as string]; }),
);

const agentMd = (name: string, body: string, extra = ''): string => `---\nname: ${name}\ndescription: >\n  The ${name} of a fictional shop.\n\n  <example>\n  user: "go"\n  </example>\nmodel: opus\n${extra}---\n\n${body}\n`;

describe('prepareCodexKit', () => {
  let home: string;
  let project: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-codex-kit-'));
    project = join(home, 'acme-shop');
    mkdirSync(join(project, '.claude', 'skills', 'checkout-rules'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'checkout-rules', 'SKILL.md'), '---\nname: checkout-rules\ndescription: Acme checkout rules\nallowed-tools: Read\n---\nRules.\n');
    // The project's own install of our skill: Codex must list ours once, not both.
    mkdirSync(join(project, '.claude', 'skills', 'dreamcontext'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'dreamcontext', 'SKILL.md'), '---\nname: dreamcontext\n---\nold\n');
    mkdirSync(join(project, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(project, '.claude', 'agents', 'cart-auditor.md'), agentMd('cart-auditor', 'Audit the cart. Use the Agent tool with subagent_type reviewer.', 'tools: Read, Grep, Bash\neffort: high\nskills:\n  - dreamcontext-agent-core\n'));
    writeFileSync(join(project, '.claude', 'agents', 'reviewer.md'), agentMd('reviewer', 'The project reviewer wins.'));
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(home, '.claude', 'agents', 'reviewer.md'), agentMd('reviewer', 'The owner reviewer.'));
    mkdirSync(join(home, '.claude', 'skills', 'owner-notes'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'owner-notes', 'SKILL.md'), '---\nname: owner-notes\ndescription: x\n---\n');
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('copies our skills in Codex words, links the others once, and touches no project and no ~/.codex', () => {
    const before = readdirSync(project, { recursive: true }).sort();
    const kit = prepareCodexKit({ home, cwd: project, packageDir: repo });
    expect(kit.skills).toMatchObject({ ok: true });
    const ours = join(home, '.dreamcontext', 'codex', 'skills');
    expect(kit.skillRoots[0]).toBe(ours);
    for (const n of ['dreamcontext', 'initializer', 'curator', 'dream-sync', 'dreamcontext-deep-research', 'patterns', 'apps']) expect(existsSync(join(ours, n, 'SKILL.md')), n).toBe(true);
    const main = readFileSync(join(ours, 'dreamcontext', 'SKILL.md'), 'utf-8');
    expect(main).not.toMatch(/\bAgent tool\b|\bSkill tool\b/);
    expect(main).toMatch(/^name: dreamcontext$/m);
    const links = kit.skillRoots[1];
    expect(readdirSync(links).sort()).toEqual(['checkout-rules', 'owner-notes']);
    expect(readlinkSync(join(links, 'checkout-rules'))).toBe(join(project, '.claude', 'skills', 'checkout-rules'));
    expect(readdirSync(project, { recursive: true }).sort()).toEqual(before);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it("turns every agent Claude would have into a role; the project's wins", () => {
    const kit = prepareCodexKit({ home, cwd: project, packageDir: repo });
    const names = kit.roles.map((r) => r.name);
    for (const n of ['sleep-tasks', 'sleep-state', 'dreamcontext-explore', 'curator-worker', 'initializer-scout', 'reviewer', 'cart-auditor']) expect(names, n).toContain(n);
    const reviewer = readToml(kit.roles.find((r) => r.name === 'reviewer')!.file);
    expect(reviewer.developer_instructions).toContain('The project reviewer wins.');
    const auditor = kit.roles.find((r) => r.name === 'cart-auditor')!;
    expect(auditor.description).toBe('The cart-auditor of a fictional shop.');
    const t = readToml(auditor.file);
    expect(t.model_reasoning_effort).toBe('high');
    expect(t.developer_instructions).toContain('spawn_agent with agent_type reviewer');
    expect(t.developer_instructions).toContain('it never edits a file');
    expect(t.developer_instructions).toContain(join(ROOT, 'skill-agent-core', 'SKILL.md'));
    expect(t.developer_instructions).not.toMatch(/\bmodel: opus\b/);
    // A role the project dropped goes with the next chat.
    rmSync(join(project, '.claude', 'agents', 'cart-auditor.md'));
    expect(prepareCodexKit({ home, cwd: project, packageDir: repo }).roles.map((r) => r.name)).not.toContain('cart-auditor');
    expect(existsSync(auditor.file)).toBe(false);
  });

  it('every shipped agent becomes a valid role', () => {
    for (const dir of ['agents', 'skill-packs/agents']) {
      for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.md'))) {
        const r = roleToml(readFileSync(join(ROOT, dir, f), 'utf-8'));
        expect(r, f).not.toBeNull();
        expect(r!.description.length, f).toBeGreaterThan(10);
        expect(r!.description, f).not.toContain('<example>');
      }
    }
  });

  it('a planted link is never written through, and a symlinked project skill is not offered', () => {
    const outside = join(home, 'outside');
    mkdirSync(outside);
    mkdirSync(join(home, '.dreamcontext', 'codex'), { recursive: true });
    symlinkSync(outside, join(home, '.dreamcontext', 'codex', 'skills'), 'dir');
    symlinkSync(outside, join(project, '.claude', 'skills', 'sneaky'), 'dir');
    const kit = prepareCodexKit({ home, cwd: project, packageDir: repo });
    expect(kit.skills).toMatchObject({ ok: true });
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(home, '.dreamcontext', 'codex', 'skills')).isSymbolicLink()).toBe(false);
    expect(readdirSync(kit.skillRoots[1])).not.toContain('sneaky');
  });

  it("a linked ~/.dreamcontext is the owner's choice: kept, and written into", () => {
    const real = join(home, 'elsewhere');
    mkdirSync(join(real, 'claude-accounts'), { recursive: true });
    symlinkSync(real, join(home, '.dreamcontext'), 'dir');
    expect(prepareCodexKit({ home, cwd: project, packageDir: repo }).skills).toMatchObject({ ok: true });
    expect(lstatSync(join(home, '.dreamcontext')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(real, 'claude-accounts'))).toBe(true);
    expect(existsSync(join(real, 'codex', 'skills', 'dreamcontext', 'SKILL.md'))).toBe(true);
  });

  it('a missing package skill costs the skills, never the chat', () => {
    const kit = prepareCodexKit({ home, cwd: project, packageDir: (s) => (s === 'skill-curator' ? null : repo(s)) });
    expect(kit.skills).toMatchObject({ ok: false, reason: 'skill-curator is missing from this install' });
    expect(kit.roles.length).toBeGreaterThan(5);
  });

  it('role launch args name the file and the description, quoted for T3', () => {
    const args = codexRoleArgs([{ name: 'cart-auditor', description: "It's the auditor", file: '/h/roles/cart-auditor.toml' }]);
    expect(args).toBe(`-c 'agents.cart-auditor.config_file="/h/roles/cart-auditor.toml"' -c 'agents.cart-auditor.description="It'\\''s the auditor"'`);
  });

  it('every copied skill keeps frontmatter Codex can read (name, description)', () => {
    const kit = prepareCodexKit({ home, cwd: project, packageDir: repo });
    const ours = kit.skillRoots[0];
    for (const n of readdirSync(ours).filter((d) => !d.startsWith('.'))) {
      const fm = parse(readFileSync(join(ours, n, 'SKILL.md'), 'utf-8').split(/^---$/m)[1]) as { name?: unknown; description?: unknown };
      expect(fm.name, n).toBe(n);
      expect(typeof fm.description, n).toBe('string');
    }
  });
});

describe('withSkillRoots', () => {
  it('sets the roots right after `initialized`, and nothing else', async () => {
    const sent: Array<[string, unknown]> = [];
    const client = {
      notify: (m: string, p: unknown) => Effect.sync(() => { sent.push([`notify:${m}`, p]); }),
      request: (m: string, p: unknown) => Effect.sync(() => { sent.push([`request:${m}`, p]); return {}; }),
    };
    const inner = { open: () => Effect.succeed(client) } as unknown as ClientFactory;
    const wrapped = withSkillRoots(inner, ['/h/.dreamcontext/codex/skills']);
    const c = await Effect.runPromise(wrapped.open({} as never) as unknown as Effect.Effect<typeof client>);
    await Effect.runPromise(c.notify('other', 1));
    await Effect.runPromise(c.notify('initialized', undefined));
    expect(sent).toEqual([
      ['notify:other', 1],
      ['notify:initialized', undefined],
      ['request:skills/extraRoots/set', { extraRoots: ['/h/.dreamcontext/codex/skills'] }],
    ]);
    expect(withSkillRoots(inner, [])).toBe(inner);
  });

  it('a refused set leaves the session as it was', async () => {
    const client = {
      notify: () => Effect.void,
      request: () => Effect.fail(new Error('unknown method')),
    };
    const wrapped = withSkillRoots({ open: () => Effect.succeed(client) } as unknown as ClientFactory, ['/x']);
    const c = await Effect.runPromise(wrapped.open({} as never) as unknown as Effect.Effect<typeof client>);
    await expect(Effect.runPromise(c.notify('initialized', undefined) as Effect.Effect<void>)).resolves.toBeUndefined();
  });
});
