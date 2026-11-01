import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appAskArgs } from '../../src/lib/apps/assistant-ask.js';
import { prepareAppChat, appBashGateHook, type AppChatEnvelope } from '../../src/lib/apps/assistant.js';
import { createAppChat } from '../../src/lib/apps/chat-store.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { appChatBriefing } from '../../src/server/chat-surface.js';

/**
 * The envelope against a REAL `claude` (plan r9, task criterion 6): haiku, one scratch project with a
 * space in its path, the argv the chat spawn builds. Spends a few cents, so it runs only with
 * DC_REAL_CLAUDE=1 after a build: `npx tsup && DC_REAL_CLAUDE=1 npx vitest run <this file>`.
 */

const real = process.env.DC_REAL_CLAUDE === '1';
const CLI = [process.execPath, resolve('dist/index.js')];

interface Frame { type?: string; subtype?: string; [k: string]: unknown }
interface Turn { cards: Array<{ tool: string; input: Record<string, unknown> }>; results: Array<{ tool: string; input: Record<string, unknown>; error: boolean; text: string }>; final: string }

class Chat {
  child: ChildProcessWithoutNullStreams;
  private buf = '';
  private uses = new Map<string, { tool: string; input: Record<string, unknown> }>();
  private turn: Turn = { cards: [], results: [], final: '' };
  private done: ((t: Turn) => void) | null = null;
  constructor(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn('claude', args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (c: Buffer) => {
      this.buf += c.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (line.trim()) { try { this.onFrame(JSON.parse(line) as Frame); } catch { /* not ours */ } }
      }
    });
  }
  private onFrame(f: Frame): void {
    if (f.type === 'control_request' && (f.request as Frame)?.subtype === 'can_use_tool') {
      const r = f.request as { tool_name: string; input: Record<string, unknown> };
      this.turn.cards.push({ tool: r.tool_name, input: r.input });
      this.child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: { behavior: 'deny', message: 'The owner said no.' } } })}\n`);
      return;
    }
    if (f.type === 'assistant') {
      for (const b of (f.message as { content: Array<Record<string, unknown>> }).content) {
        if (b.type === 'tool_use') this.uses.set(String(b.id), { tool: String(b.name), input: b.input as Record<string, unknown> });
      }
    }
    if (f.type === 'user') {
      const content = (f.message as { content: unknown }).content;
      if (Array.isArray(content)) for (const b of content as Array<Record<string, unknown>>) {
        if (b.type !== 'tool_result') continue;
        const u = this.uses.get(String(b.tool_use_id));
        if (u) this.turn.results.push({ ...u, error: b.is_error === true, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      }
    }
    if (f.type === 'result') { this.turn.final = String(f.result ?? ''); const d = this.done; this.done = null; d?.(this.turn); }
  }
  ask(text: string): Promise<Turn> {
    this.turn = { cards: [], results: [], final: '' };
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('turn timed out')), 170_000);
      this.done = (x) => { clearTimeout(t); res(x); };
      this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
    });
  }
  end(): void { this.child.stdin.end(); this.child.kill(); }
}

describe.skipIf(!real)('a real claude in the envelope', () => {
  let home: string; let project: string; let root: string; let data: string; let app: AppChatEnvelope; let chat: Chat; let id: string;

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc real-')));
    project = join(home, 'my proj'); mkdirSync(join(project, '.claude'), { recursive: true });
    mkdirSync(join(project, '_dream_context'));
    root = join(home, 'my proj-apps', 'yuk'); mkdirSync(root, { recursive: true });
    writeFileSync(join(project, 'notes.txt'), 'project file\n');
    writeFileSync(join(project, '.env'), 'SECRET=never-this\n');
    writeFileSync(join(root, '.env'), 'SECRET=never-this-either\n');
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk', name: 'Yuk', agent: { own: true } }));
    writeFileSync(join(root, 'ASSISTANT.md'), 'You help with a test. Do exactly what each message asks, one tool call after another, and never comment.\n');
    const rec = registerApp(home, { projectRoot: project, vault: 'real', slug: 'yuk', name: 'Yuk', root });
    id = randomUUID();
    const r = createAppChat({ id, hash: rec.hash, slug: 'yuk', projectRoot: project, member: null }, home);
    const p = prepareAppChat(r, { projectRoot: project, home, cli: CLI });
    if (!p.ok) throw new Error(p.reason);
    app = p.app; data = app.dataDir;
    const settings = join(home, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: app.hooks }));
    chat = new Chat([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
      '--permission-mode', app.permissionMode, '--allowedTools', ...app.allowed, '--setting-sources', 'project',
      ...app.addDirs.flatMap((d) => ['--add-dir', d]), '--settings', settings, '--session-id', id, '--model', 'haiku',
      '--append-system-prompt', app.briefing, '--disallowedTools', ['EnterPlanMode,ExitPlanMode', ...app.denied].join(','), '--strict-mcp-config',
    ], project, app.env);
  });
  afterAll(() => { chat?.end(); app?.dispose(); if (home) rmSync(home, { recursive: true, force: true }); });

  it('Write and Edit fail on every protected path; the data dir takes a write', async () => {
    const paths = [join(project, 'w.txt'), join(root, 'ASSISTANT.md'), join(root, 'dreamcontext-app.json'), join(project, '.claude', 'w.json'), join(home, '.dreamcontext', 'apps', 'chats', 'w.json')];
    const t = await chat.ask(`Call the Write tool once for each of these absolute paths with the content "x", in order, even if one fails:\n${paths.join('\n')}\nThen call Write on ${join(data, 'ok.txt')} with "x". Then say DONE.`);
    for (const p of paths.slice(0, 1).concat(paths.slice(3))) expect(existsSync(p), p).toBe(false);
    expect(readFileSync(join(root, 'ASSISTANT.md'), 'utf-8')).toContain('You help with a test');
    expect(readFileSync(join(root, 'dreamcontext-app.json'), 'utf-8')).toContain('yuk');
    expect(readFileSync(join(data, 'ok.txt'), 'utf-8')).toBe('x');
    expect(t.cards.map((c) => c.input.file_path)).toEqual([]);
  }, 180_000);

  it('credentials read as refused, and a tool that takes no permission is denied', async () => {
    const t = await chat.ask(`Call Read on ${join(root, '.env')}. Then Read on ${join(project, '.env')}. Then Read on ${join(home, '.dreamcontext', 'apps', 'registry.json')}. Then call the CronCreate tool and the EnterWorktree tool if you have them. Then say DONE.`);
    const reads = t.results.filter((r) => r.tool === 'Read');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const r of reads) expect(r.text).not.toContain('never-this');
    expect(t.results.filter((r) => r.tool === 'CronCreate' || r.tool === 'EnterWorktree').every((r) => r.error)).toBe(true);
  }, 180_000);

  it('the Bash gate: a shell search raises a card, a read verb is denied bare, a listed verb runs', async () => {
    const t = await chat.ask(`Run these with the Bash tool, one call each, in order, even if one fails: \`grep -r SECRET .\` then \`cat notes.txt\` then \`ls ${root}\` then \`dreamcontext --version\`. Then say DONE.`);
    const commands = t.cards.filter((c) => c.tool === 'Bash').map((c) => String(c.input.command));
    expect(commands.some((c) => c.startsWith('grep'))).toBe(true);
    expect(commands.some((c) => c.startsWith('cat'))).toBe(false);
    expect(commands.some((c) => c.startsWith('ls'))).toBe(false);
    const ls = t.results.find((r) => r.tool === 'Bash' && String(r.input.command).startsWith('ls'));
    expect(ls?.text).toContain('ASSISTANT.md');
    const cat = t.results.find((r) => r.tool === 'Bash' && String(r.input.command).startsWith('cat'));
    expect(cat?.text).not.toContain('project file');
  }, 180_000);

  it('the hook command fails closed on what it can see', () => {
    const run = (cli: string[], input = '{"tool_input":{"command":"ls"}}') => spawnSync('/bin/sh', ['-c', (appBashGateHook(cli, join(home, 'gate.json')).PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command], { input, encoding: 'utf-8' }).status;
    writeFileSync(join(home, 'gate.json'), JSON.stringify({ slug: 'yuk', appRoot: root, dataDir: data, actions: [] }));
    const fake = (body: string) => { const f = join(home, `fake-${randomUUID()}.sh`); writeFileSync(f, body); return ['/bin/sh', f]; };
    expect(run(['/nope/missing'])).toBe(2);
    expect(run(fake('exit 1'))).toBe(2);
    expect(run(fake('echo not json'))).toBe(2);
    expect(run(fake('echo noise; echo \'{}\''))).toBe(2);
    expect(run(fake('exit 0'))).toBe(2);
    expect(run(CLI, '')).toBe(2);
    expect(run(CLI)).toBe(0);
  });

  it('dc.ask: a headless turn reads its folder and nothing else, and leaves no session', async () => {
    writeFileSync(join(root, 'fact.txt'), 'the answer is forty-two\n');
    const prompt = `Do these in order, each even if one fails. Read ${join(root, 'fact.txt')}. Read ${join(project, 'notes.txt')}. Read ${join(root, '.env')}. Grep for "SECRET" in ${root}. Glob "*.txt" in ${project}. Run Bash "id". Use WebFetch on https://example.com. Write ${join(root, 'x.txt')}. Then print every line of content you actually got.`;
    const out = spawnSync('claude', appAskArgs(prompt, root, home), { cwd: root, encoding: 'utf-8', timeout: 110_000 });
    const doc = JSON.parse(out.stdout) as { result: string; session_id: string };
    expect(doc.result).toContain('forty-two');
    expect(doc.result).not.toContain('project file');
    expect(doc.result).not.toContain('never-this');
    expect(existsSync(join(root, 'x.txt'))).toBe(false);
  }, 120_000);
});

describe.skipIf(!real)('a real claude on a real vault, hooks live', () => {
  let home: string; let project: string; let root: string; let app: AppChatEnvelope; let chat: Chat;
  const counts: Array<[string, number]> = [];

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-vault-')));
    project = join(home, 'proj'); mkdirSync(project, { recursive: true });
    const bin = join(home, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'dreamcontext'), `#!/bin/sh\nexec "${process.execPath}" "${CLI[1]}" "$@"\n`, { mode: 0o755 });
    spawnSync(process.execPath, [CLI[1], 'init', '-y', '--name', 'proj', '--platforms', 'claude'], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.json'), readFileSync(resolve('tests/fixtures/apps/hooks-settings.json'), 'utf-8'));
    writeFileSync(join(project, '_dream_context', 'knowledge', 'load-note.md'), '---\ntitle: load note\ntype: knowledge\n---\n\nThe load ceiling of this machine is twelve.\n');
    root = join(home, 'proj-apps', 'yuk'); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'hedef-sinir.md'), 'The alarm threshold is 77 percent.\n');
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk', name: 'Yuk', agent: { own: true } }));
    writeFileSync(join(root, 'ASSISTANT.md'), 'You answer questions about this machine\'s load. Be brief.\n');
    const rec = registerApp(home, { projectRoot: project, vault: 'real', slug: 'yuk', name: 'Yuk', root });
    const r = createAppChat({ id: randomUUID(), hash: rec.hash, slug: 'yuk', projectRoot: project, member: null }, home);
    const p = prepareAppChat(r, { projectRoot: project, home, cli: CLI });
    if (!p.ok) throw new Error(p.reason);
    app = p.app;
    const settings = join(home, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks: app.hooks }));
    chat = new Chat([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
      '--permission-mode', app.permissionMode, '--allowedTools', ...app.allowed, '--setting-sources', 'project',
      ...app.addDirs.flatMap((d) => ['--add-dir', d]), '--settings', settings, '--session-id', r.id, '--model', 'haiku',
      '--append-system-prompt', `${app.briefing}\n\n${appChatBriefing(app)}`, '--disallowedTools', ['EnterPlanMode,ExitPlanMode', ...app.denied].join(','), '--strict-mcp-config',
    ], project, { ...app.env, PATH: `${bin}:${process.env.PATH}` });
  });
  afterAll(() => { chat?.end(); app?.dispose(); console.log(`cards per turn: ${JSON.stringify(counts)}`); if (home) rmSync(home, { recursive: true, force: true }); });

  it.each([
    ['a metric', 'What does the insight called weekly-load say?'],
    ['an action', 'What actions does this app have, and what are its current status and logs?'],
    ['a recall', 'What do we know about the load ceiling of this machine?'],
    ['a file it is not told the name of', 'There is a note in this app\'s folder about the alarm threshold. What is the threshold?'],
  ])('%s raises no card', async (name, q) => {
    const t = await chat.ask(q);
    counts.push([name, t.cards.length]);
    console.log(`${name}: ${t.results.map((r) => `${r.tool}:${String(r.input.command ?? r.input.file_path ?? '').slice(0, 60)}`).join(' | ')}`);
    expect(t.cards.map((c) => JSON.stringify(c.input))).toEqual([]);
  }, 180_000);

  it('a shell search raises exactly one card, and the project\'s own PreToolUse hook still fires', async () => {
    const t = await chat.ask('Run this one command with Bash and nothing else: grep -r threshold .');
    counts.push(['a shell search', t.cards.length]);
    expect(t.cards).toHaveLength(1);
    const heavy = await chat.ask('Run exactly this one command with Bash: npx vitest run');
    expect(heavy.cards).toEqual([]);
    expect(heavy.results.map((r) => r.text).join(' ')).toContain('heavy step');
  }, 240_000);

  it('the session-start and stop hooks ran on this chat', () => {
    const state = readFileSync(join(project, '_dream_context', 'state', '.sleep.json'), 'utf-8');
    expect(JSON.parse(state).sessions.length).toBeGreaterThan(0);
  });

  it('on a high-debt vault an app chat gets no sleep directive', () => {
    const file = join(project, '_dream_context', 'state', '.sleep.json');
    const state = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...state, debt: 99 }));
    const run = (cmd: string, extra: Record<string, string>) => spawnSync(process.execPath, [CLI[1], 'hook', cmd], {
      cwd: project, encoding: 'utf-8', input: JSON.stringify({ session_id: randomUUID(), source: 'startup', prompt: 'hello', cwd: project }),
      env: { ...process.env, HOME: home, DREAMCONTEXT_AGENT_CHAT: '', ...extra },
    }).stdout;
    const line = (t: string) => t.split('\n').filter((l) => /sleep debt|run a sleep|consolidat/i.test(l) && !/Consolidated/.test(l));
    for (const cmd of ['session-start', 'user-prompt-submit']) {
      expect(line(run(cmd, {})).length, cmd).toBeGreaterThan(0);
      expect(line(run(cmd, { DREAMCONTEXT_AGENT_CHAT: 'app-yuk' })), cmd).toEqual([]);
    }
  });
});
