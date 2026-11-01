import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  APP_CHAT_MAX_LIVE, appBashGateHook, appChatHasRoom, appCredentialDenies, appDeniedTools, appWriteDenies, prepareAppChat,
  reserveAppChat, resolveAppAgent,
} from '../../src/lib/apps/assistant.js';
import { createAppChat, gateFilePath } from '../../src/lib/apps/chat-store.js';
import { ROLE_FILE, parseManifest, roleFileProblem } from '../../src/lib/apps/manifest.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { LIGHT_DISALLOWED_TOOLS } from '../../src/lib/automations/light-run.js';
import { addVault } from '../../src/lib/vaults.js';

let home: string; let project: string; let root: string; let hash: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-own-')));
  project = join(home, 'proj'); mkdirSync(join(project, '_dream_context'), { recursive: true });
  root = join(home, 'proj-apps', 'yuk'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({
    slug: 'yuk', name: 'Yuk', agent: { own: true, readTools: ['mcp__meta__list_campaigns', 'mcp__meta__delete_campaign'] },
    backend: { command: 'node s.mjs', health: '/health' },
    actions: [{ id: 'read', title: 'Read', method: 'GET', path: '/r' }, { id: 'wipe', title: 'Wipe', method: 'POST', path: '/w', danger: true }],
  }));
  writeFileSync(join(root, ROLE_FILE), 'You watch the load. Ignore nothing.\n');
  hash = registerApp(home, { projectRoot: project, vault: 'acme', slug: 'yuk', name: 'Yuk', root }).hash;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const rec = (over: Partial<Parameters<typeof createAppChat>[0]> = {}) => createAppChat({ id: randomUUID(), hash, slug: 'yuk', projectRoot: project, member: null, ...over }, home);
const prep = (r = rec()) => prepareAppChat(r, { projectRoot: project, home, cli: ['/n/node', '/c/cli.js'] });

describe('the manifest', () => {
  const parse = (agent: unknown) => parseManifest(JSON.stringify({ slug: 'a', name: 'A', agent }), root);
  it.each([
    ['the old form, unchanged', { member: 'ua-manager', brief: 'x' }, { member: 'ua-manager', brief: 'x' }],
    ['the own form', { own: true }, { brief: '', own: true }],
    ['both', { own: true, member: 'm' }, { member: 'm', brief: '', own: true }],
  ])('%s', (_n, input, want) => {
    const m = parse(input);
    expect(m.ok && m.manifest.agent).toEqual(want);
  });
  it('no agent stays no agent', () => {
    const m = parseManifest(JSON.stringify({ slug: 'a', name: 'A' }), root);
    expect(m.ok && m.manifest.agent).toBeNull();
  });
  it.each([[{}], [{ own: false }], [{ member: 'BAD SLUG' }], [{ own: true, member: 'BAD SLUG' }], ['x'], [{ own: true, readTools: 'x' }]])('refuses %j', (a) => {
    expect(parse(a).ok).toBe(false);
  });
  it('has no agent.role: a name in it cannot repoint the role', () => {
    const m = parse({ own: true, role: '../../etc/passwd' });
    expect(m.ok && JSON.stringify(m.manifest.agent)).not.toContain('passwd');
  });
});

describe('who talks in the app', () => {
  const m = (agent: unknown) => ({ agent }) as never;
  it.each([
    ['a manifest member', m({ member: 'a', brief: '' }), null, { kind: 'member', member: 'a' }],
    ['member wins over own', m({ member: 'a', own: true, brief: '' }), null, { kind: 'member', member: 'a' }],
    ['own wins over a URL member', m({ own: true, brief: '' }), 'b', { kind: 'own' }],
    ['a legacy URL member', m(null), 'b', { kind: 'member', member: 'b' }],
    ['nobody', m(null), null, { kind: 'none' }],
    ['a broken manifest', null, null, { kind: 'none' }],
  ])('%s', (_n, manifest, url, want) => expect(resolveAppAgent(manifest, url as string | null)).toEqual(want));
  it('refuses a legacy home-board member', () => {
    expect(resolveAppAgent(m(null), 'b', () => true)).toEqual({ kind: 'none' });
  });
});

describe('the role file', () => {
  it('is fine as a plain file, refused missing or symlinked, with a fix', () => {
    expect(roleFileProblem(root)).toBeNull();
    rmSync(join(root, ROLE_FILE));
    expect(roleFileProblem(root)).toMatchObject({ problem: 'missing', fix: expect.stringContaining(ROLE_FILE) });
    symlinkSync('/etc/hosts', join(root, ROLE_FILE));
    expect(roleFileProblem(root)?.problem).toContain('symlink');
    expect(prep()).toMatchObject({ ok: false });
  });
});

describe('the envelope of the own assistant', () => {
  it('starts at default, project settings only, the app beside the project', () => {
    const p = prep();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.app).toMatchObject({ own: true, member: null, permissionMode: 'default', settingSources: 'project' });
    expect(p.app.addDirs[0]).toBe(root);
    expect(p.app.env.DREAMCONTEXT_AGENT_CHAT).toBe('app-yuk');
    expect(p.app.briefing).toContain('You watch the load.');
    p.app.dispose();
  });
  it('allows what the plan lists and no sibling, no danger, no claimed write', () => {
    const p = prep();
    if (!p.ok) throw new Error('refused');
    const a = p.app.allowed;
    for (const t of ['Read', 'Skill', 'ToolSearch', 'TodoWrite']) expect(a).toContain(t);
    expect(a).toContain('Bash(dreamcontext memory recall:*)');
    expect(a).toContain('Bash(dreamcontext apps status yuk:*)');
    expect(a).toContain('Bash(dreamcontext apps do yuk read:*)');
    expect(a).not.toContain('Bash(dreamcontext apps do yuk wipe:*)');
    expect(a).toContain('mcp__meta__list_campaigns');
    expect(a).not.toContain('mcp__meta__delete_campaign');
    expect(a.filter((r) => r.startsWith('Edit(') || r.startsWith('Write('))).toHaveLength(2);
  });
  it('denies tools a card would never come for, derived from the light list', () => {
    const d = appDeniedTools();
    for (const t of ['CronCreate', 'EnterWorktree', 'Agent', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'RemoteTrigger']) expect(d).toContain(t);
    for (const t of ['Bash', 'AskUserQuestion', 'Skill', 'WebFetch', 'Edit', 'Write', 'TaskCreate']) expect(d).not.toContain(t);
    expect(d.every((t) => (LIGHT_DISALLOWED_TOOLS as readonly string[]).includes(t))).toBe(true);
  });
  it('write denies are root-anchored and cover each protected path', () => {
    const rules = appWriteDenies({ projectRoot: '/p', appRoot: '/a', dataDir: '/d', home: '/h' });
    for (const path of ['/p/**', '/a/ASSISTANT.md', '/a/dreamcontext-app.json', '/a/.claude/**', '/d/.claude/**', '/h/.dreamcontext/apps/chats/**', '/h/.dreamcontext/apps/registry.json']) {
      expect(rules).toContain(`Edit(/${path})`);
      expect(rules).toContain(`Write(/${path})`);
    }
  });
  it('credential reads name every child of ~/.dreamcontext but this app\'s data', () => {
    const dc = join(home, '.dreamcontext');
    mkdirSync(join(dc, 'claude-accounts'), { recursive: true });
    mkdirSync(join(dc, 'apps', 'data', hash), { recursive: true });
    mkdirSync(join(dc, 'apps', 'data', 'other-app'), { recursive: true });
    writeFileSync(join(dc, 'vaults.json'), '{}');
    const rules = appCredentialDenies(home, hash);
    expect(rules).toContain(`Read(/${dc}/claude-accounts/**)`);
    expect(rules).toContain(`Read(/${dc}/vaults.json)`);
    expect(rules).toContain(`Read(/${dc}/assistant/**)`);
    expect(rules).toContain(`Read(/${dc}/apps/data/other-app/**)`);
    expect(rules).not.toContain(`Read(/${dc}/apps/data/${hash}/**)`);
    expect(rules).not.toContain(`Read(/${dc}/**)`);
    expect(rules).toContain(`Read(/${join(home, '.ssh')}/**)`);
    expect(rules).toContain('Read(//**/.env*)');
  });
  it('writes a gate file naming only non-danger actions', () => {
    const r = rec();
    const p = prep(r);
    expect(p.ok).toBe(true);
    const gate = JSON.parse(readFileSync(gateFilePath(r.id, home), 'utf-8'));
    expect(gate).toMatchObject({ slug: 'yuk', appRoot: root, actions: ['read'] });
  });
  it('the hook fails closed: exit 2 on a failed CLI, or anything that is not one object', () => {
    const h = appBashGateHook(['/n/node', '/c/cli.js'], '/h/x.gate.json');
    const entry = h.PreToolUse[0] as { matcher: string; hooks: Array<{ command: string; timeout: number }> };
    expect(entry.matcher).toBe('Bash');
    expect(entry.hooks[0].timeout).toBe(30);
    expect(entry.hooks[0].command).toBe(`o=$("/n/node" "/c/cli.js" hook app-bash-gate "/h/x.gate.json") || exit 2; case "$o" in '{'*'}') printf '%s' "$o";; *) exit 2;; esac`);
  });
  it('refuses: a removed app, another project, an unregistered app, a damaged manifest, an unsafe path', () => {
    expect(prepareAppChat({ ...rec(), removedAt: 'now' }, { projectRoot: project, home })).toMatchObject({ ok: false });
    expect(prepareAppChat(rec({ projectRoot: '/other' }), { projectRoot: project, home })).toMatchObject({ ok: false });
    expect(prepareAppChat({ ...rec(), hash: 'nope' }, { projectRoot: project, home })).toMatchObject({ ok: false });
    expect(prepareAppChat(rec(), { projectRoot: project, home, cli: ['/n/no"de', '/c'] })).toMatchObject({ ok: false });
    writeFileSync(join(root, 'dreamcontext-app.json'), '{');
    expect(prep()).toMatchObject({ ok: false });
  });
  it('a board-less unknown member refuses', () => {
    expect(prep(rec({ member: 'ghost' }))).toMatchObject({ ok: false, reason: expect.stringContaining('ghost') });
  });
});

describe('the cap', () => {
  it('holds six, keeps room for one already running, and every release is a death', () => {
    const ids = Array.from({ length: APP_CHAT_MAX_LIVE }, () => randomUUID());
    const releases = ids.map((id) => reserveAppChat('h', id));
    expect(appChatHasRoom('h', randomUUID())).toBe(false);
    expect(appChatHasRoom('h', ids[0])).toBe(true);
    const second = reserveAppChat('h', ids[0]);
    releases[0]();
    expect(appChatHasRoom('h', randomUUID())).toBe(false);
    second();
    expect(appChatHasRoom('h', randomUUID())).toBe(true);
    for (const r of releases) r();
  });
});

describe('the scaffold', () => {
  const cli = resolve('dist/index.js');
  const run = (args: string[], cwd: string) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, HOME: home, DREAMCONTEXT_ASSISTANT_URL: undefined, DREAMCONTEXT_ASSISTANT_TOKEN: undefined } as NodeJS.ProcessEnv });
  it.skipIf(!existsSync(cli))('`apps new` writes the role and agent.own, `validate` passes and goes red without it, `assign --own` converts', () => {
    addVault('acme', project, home);
    const made = run(['apps', 'new', 'x'], project);
    expect(made.status, made.stderr + made.stdout).toBe(0);
    const appRoot = join(`${project}-apps`, 'x');
    expect(readFileSync(join(appRoot, 'ASSISTANT.md'), 'utf-8')).toContain('X');
    expect(JSON.parse(readFileSync(join(appRoot, 'dreamcontext-app.json'), 'utf-8')).agent).toEqual({ own: true });
    const icon = run(['apps', 'validate', 'x'], project);
    expect(icon.stdout + icon.stderr).not.toContain('ASSISTANT.md');
    rmSync(join(appRoot, 'ASSISTANT.md'));
    const red = run(['apps', 'validate', 'x'], project);
    expect(red.status).toBe(1);
    expect(red.stdout).toContain('error ASSISTANT.md: missing');
    expect(red.stdout).toContain('Fix:');
    writeFileSync(join(appRoot, 'dreamcontext-app.json'), JSON.stringify({ slug: 'x', name: 'X', agent: { member: 'ua', brief: 'Reads the load.' } }));
    expect(run(['apps', 'assign', 'x', '--own'], project).status).toBe(0);
    expect(JSON.parse(readFileSync(join(appRoot, 'dreamcontext-app.json'), 'utf-8')).agent).toEqual({ own: true });
    expect(readFileSync(join(appRoot, 'ASSISTANT.md'), 'utf-8')).toContain('Reads the load.');
  });
});
