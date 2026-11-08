import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  APP_CHAT_MAX_LIVE, appBashGateHook, appChatHasRoom, appCredentialDenies, appDeniedTools, appWriteDenies, prepareAppChat,
  reserveAppChat, resolveAppAgent, userChatDefaults,
} from '../../src/lib/apps/assistant.js';
import { createAppChat, gateFilePath, rotateAppChat } from '../../src/lib/apps/chat-store.js';
import { ROLE_FILE, parseManifest, roleFileProblem } from '../../src/lib/apps/manifest.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { LIGHT_DISALLOWED_TOOLS } from '../../src/lib/automations/light-run.js';
import { rulePath } from '../../src/lib/automations/board-scope.js';
import { addVault } from '../../src/lib/vaults.js';
import { computeChatSessions } from '../../src/server/routes/agent-chat-sessions.js';

let home: string; let project: string; let root: string; let hash: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-own-')));
  project = join(home, 'proj'); mkdirSync(join(project, '_dream_context'), { recursive: true });
  root = join(home, 'proj-apps', 'yuk'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({
    slug: 'yuk', name: 'Yuk', agent: { own: true, readTools: ['mcp__meta__list_campaigns', 'mcp__meta__delete_campaign'] },
    backend: { command: 'node s.mjs', health: '/health' },
    actions: [{ id: 'read', title: 'Read', method: 'GET', path: '/r' }, { id: 'wipe', title: 'Wipe', method: 'POST', path: '/w', danger: true }, { id: 'ping', title: 'Ping', method: 'POST', path: '/p' }],
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
    const rules = appWriteDenies({ projectRoot: '/p', appRoot: '/a', dataDir: '/d', home: '/h', slug: 'yuk' });
    for (const path of ['/a/ASSISTANT.md', '/a/dreamcontext-app.json', '/a/.claude/**', '/d/.claude/**', '/h/.dreamcontext/apps/chats/**', '/h/.dreamcontext/apps/registry.json']) {
      expect(rules).toContain(`Edit(/${path})`);
      expect(rules).toContain(`Write(/${path})`);
    }
    // The project is no longer denied whole: its data folder is inside it (plan-veri K1).
    expect(rules).not.toContain('Edit(//p/**)');
  });
  it('the belt enumerates the project down the data folder chain, sparing only that chain', () => {
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'README.md'), 'x');
    mkdirSync(join(project, '_dream_context', 'core'), { recursive: true });
    mkdirSync(join(project, '_dream_context', 'apps', 'other'), { recursive: true });
    mkdirSync(join(project, '_dream_context', 'apps', 'yuk'), { recursive: true });
    const rules = appWriteDenies({ projectRoot: project, appRoot: root, dataDir: join(project, '_dream_context', 'apps', 'yuk'), home, slug: 'yuk' });
    const r = (p: string) => rulePath(p);
    expect(rules).toContain(`Write(/${r(join(project, 'src'))}/**)`);
    expect(rules).toContain(`Write(/${r(join(project, 'README.md'))})`);
    expect(rules).toContain(`Write(/${r(join(project, '_dream_context', 'core'))}/**)`);
    expect(rules).toContain(`Write(/${r(join(project, '_dream_context', 'apps', 'other'))}/**)`);
    expect(rules.some((x) => x.includes(`${r(join(project, '_dream_context', 'apps', 'yuk'))}/**`) && x.startsWith('Write'))).toBe(false);
    expect(rules).not.toContain(`Write(/${r(join(project, '_dream_context'))}/**)`);
  });
  it('a file name the shell would expand gets no belt rule and never refuses the chat (review r1 M1)', () => {
    writeFileSync(join(project, 'notes!.md'), 'x');
    writeFileSync(join(project, 'Icon\r'), '');
    const rules = appWriteDenies({ projectRoot: project, appRoot: root, dataDir: join(project, '_dream_context', 'apps', 'yuk'), home, slug: 'yuk' });
    expect(rules.some((x) => x.includes('notes!') || x.includes('Icon'))).toBe(false);
    expect(prep()).toMatchObject({ ok: true });
  });
  it('credential reads name every child of ~/.dreamcontext, all of its apps/ and other apps\' data in the brain', () => {
    const dc = join(home, '.dreamcontext');
    mkdirSync(join(dc, 'claude-accounts'), { recursive: true });
    mkdirSync(join(project, '_dream_context', 'apps', 'yuk'), { recursive: true });
    mkdirSync(join(project, '_dream_context', 'apps', 'other-app'), { recursive: true });
    writeFileSync(join(dc, 'vaults.json'), '{}');
    const rules = appCredentialDenies(home, { projectRoot: project, slug: 'yuk' });
    // In the rule's spelling: the path itself here, `/c/Users/...` on Windows (rule-path-win32.test.ts).
    const r = (p: string) => rulePath(p);
    expect(rules).toContain(`Read(/${r(join(dc, 'claude-accounts'))}/**)`);
    expect(rules).toContain(`Read(/${r(join(dc, 'vaults.json'))})`);
    expect(rules).toContain(`Read(/${r(join(dc, 'assistant'))}/**)`);
    expect(rules).toContain(`Read(/${r(join(dc, 'apps'))}/**)`);
    expect(rules).toContain(`Read(/${r(join(dc, 'apps', 'learn'))}/**)`);
    expect(rules).toContain(`Read(/${r(join(dc, 'apps', 'backup'))}/**)`);
    expect(rules).toContain(`Read(/${r(join(project, '_dream_context', 'apps', 'other-app'))}/**)`);
    expect(rules).not.toContain(`Read(/${r(join(project, '_dream_context', 'apps', 'yuk'))}/**)`);
    expect(rules).not.toContain(`Read(/${r(dc)}/**)`);
    expect(rules).toContain(`Read(/${r(join(home, '.ssh'))}/**)`);
    expect(rules.some((x) => x.includes('\\'))).toBe(false);
    expect(rules).toContain('Read(//**/.env*)');
    expect(rules).toContain('Read(//**/.secrets.json)');
    expect(rules).toContain('Read(//**/lab/credentials.json)');
  });
  it('writes a gate file naming only non-danger actions', () => {
    const r = rec();
    const p = prep(r);
    expect(p.ok).toBe(true);
    const gate = JSON.parse(readFileSync(gateFilePath(r.id, home), 'utf-8'));
    expect(gate).toMatchObject({ slug: 'yuk', appRoot: root, actions: ['read'], projectRoot: project, dataDir: join(project, '_dream_context', 'apps', 'yuk') });
    // Both gates ride the own assistant: Bash and the file tools.
    if (!p.ok) throw new Error(p.reason);
    const matchers = (p.app.hooks?.PreToolUse as Array<{ matcher: string }>).map((h) => h.matcher);
    expect(matchers).toEqual(['Bash', 'Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob']);
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

describe("the owner's defaults", () => {
  it('reads a sandbox account and account #0, and names nothing with no file', () => {
    const sandbox = join(home, 'sandbox'); mkdirSync(sandbox);
    writeFileSync(join(sandbox, 'settings.json'), JSON.stringify({ model: 'sonnet', effortLevel: 'high' }));
    expect(userChatDefaults(sandbox)).toEqual({ model: 'sonnet', effort: 'high' });
    const real = join(home, 'realhome'); mkdirSync(join(real, '.claude'), { recursive: true });
    writeFileSync(join(real, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    expect(userChatDefaults(real)).toEqual({ model: 'opus', effort: '' });
    expect(userChatDefaults(join(home, 'none'))).toEqual({ model: '', effort: '' });
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

describe('a bound member', () => {
  const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
  const dc = (...args: string[]) => spawnSync(process.execPath, [resolve('dist/index.js'), ...args], { cwd: project, encoding: 'utf-8', env: { ...clean(), HOME: home } });
  it.skipIf(!existsSync(resolve('dist/index.js')))('runs free at auto, with danger actions and apps call denied, the file gate only, no strict settings', () => {
    addVault('acme', project, home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', '.secrets.json'), '{"github":{"token":"gho_fake_verify_token","login":"verify-user"}}');
    expect(dc('agents', 'create', 'ua', '--title', 'UA', '--prompt', 'Run the ads.').status).toBe(0);
    expect(dc('agents', 'edit', 'ua', '--autonomy', 'free').status).toBe(0);
    expect(dc('agents', 'approve', 'ua', '--yes').status).toBe(0);
    const saved = process.env.HOME;
    process.env.HOME = home;
    const p = prep(rec({ member: 'ua' }));
    process.env.HOME = saved;
    if (!p.ok) throw new Error(p.reason);
    expect(p.app).toMatchObject({ own: false, member: 'ua', permissionMode: 'auto', settingSources: null, allowed: [] });
    // plan-veri K1: a bound member writes only in the app's data folder too (no Bash gate).
    expect((p.app.hooks?.PreToolUse as Array<{ matcher: string }>).map((h) => h.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob']);
    expect(p.app.denied).toContain('Bash(dreamcontext apps call:*)');
    expect(p.app.denied).toContain('Bash(dreamcontext apps do yuk wipe:*)');
    // No card in a member's chat: a plain changing tool is denied too, not only a danger one.
    expect(p.app.denied).toContain('Bash(dreamcontext apps do yuk ping:*)');
    expect(p.app.denied).not.toContain('Bash(dreamcontext apps do yuk read:*)');
    expect(p.app.denied).toContain('CronCreate');
    expect(p.app.env.DREAMCONTEXT_AGENT_CHAT).toBe('app-yuk');
    expect(p.app.briefing).toContain('Run the ads.');
    p.app.dispose();
  });
});

describe('the history of an app', () => {
  it('lists its own conversations before the limit, and nothing else', async () => {
    const dir = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const line = (id: string, text: string) => `${JSON.stringify({ type: 'user', sessionId: id, cwd: project, uuid: id, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })}\n`;
    const own = rec();
    writeFileSync(join(dir, `${own.id}.jsonl`), line(own.id, 'the app chat'));
    for (let i = 0; i < 5; i++) { const id = randomUUID(); writeFileSync(join(dir, `${id}.jsonl`), line(id, `owner chat ${i}`)); }
    const r = await computeChatSessions(join(project, '_dream_context'), { app: 'yuk', limit: '1' }, { home, waitMs: 0 }) as { sessions: Array<{ id: string }> };
    expect(r.sessions.map((s) => s.id)).toEqual([own.id]);
    // A rotated chain is one row, under its pin.
    const next = rotateAppChat(own, randomUUID(), home);
    writeFileSync(join(dir, `${next?.id}.jsonl`), line(String(next?.id), 'after clear'));
    const rotated = await computeChatSessions(join(project, '_dream_context'), { app: 'yuk' }, { home, waitMs: 0 }) as { sessions: Array<{ id: string }> };
    expect(rotated.sessions.map((s) => s.id)).toEqual([own.id]);
    const other = await computeChatSessions(join(project, '_dream_context'), { app: 'nope' }, { home, waitMs: 0 }) as { sessions: unknown[] };
    expect(other.sessions).toEqual([]);
  });
});
