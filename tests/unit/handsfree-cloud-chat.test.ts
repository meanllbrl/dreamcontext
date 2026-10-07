// The hands-free chat chokepoints: in the cloud every agent spawns as dcuser through
// spawnAsWorker with an allow-listed env (AC19); on the laptop a chat inside a locked root is
// refused (AC6); and cutLiveChats ends whole process groups while the sessions stay resumable
// (AC12, pinned for the laptop's go/return and the cloud's `cut`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawned: Array<{ child: FakeChild; file: string; args: string[]; opts: { env?: Record<string, string>; detached?: boolean; cwd?: string } }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 424242;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((file: string, args: string[], opts: Record<string, unknown>) => {
      const child = new FakeChild();
      spawned.push({ child, file, args, opts: opts as never });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});

const { startChatSession, handleAgentFile, inlineModeNoteCommand, withoutShellJobControlNoise } = await import('../../src/server/routes/agent-chat.js');
const { autoModeSettings } = await import('../../src/lib/auto-mode-rules.js');
const { CHAT_SURFACE_BRIEFING } = await import('../../src/server/chat-surface.js');
const { setWorkerInProcessForTests } = await import('../../src/server/cloud-worker.js');
const { cutLiveChats, liveChatsSnapshot, CUT_KILL_GRACE_MS } = await import('../../src/server/routes/agent-chat-live.js');
const { writeClaudeAccounts, sandboxDirFor } = await import('../../src/lib/claude-accounts.js');
const { beginGoing } = await import('../../src/lib/handsfree/trip-state.js');
const { setCloudPhaseSource, setCloudTripRootsSource } = await import('../../src/server/cloud-mode.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const ENV_KEYS = ['HOME', 'DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP', 'GITHUB_TOKEN', 'DC_HF_TRANSFER_SECRET', 'DC_HF_ORIGIN', 'DC_HF_SERVER_DIR'];
const saved: Record<string, string | undefined> = {};
let home: string;

function account(id: string, preferred: boolean) {
  return { id, accountUuid: '', email: `${id}@example.invalid`, organizationUuid: '', organizationName: '', tier: 'max', configDir: join(home, '.dreamcontext', 'claude-accounts', id), preferred };
}

function open(projectRoot: string, opts: Partial<Parameters<typeof startChatSession>[2]> = {}): FakeWs {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, projectRoot, {
    bypass: false, sessionId: '', resumeId: '', model: '', effort: '', mode: 'basic', account: '', initialPrompt: '', deferPrompt: false, ...opts,
  });
  return ws;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'hf-chat-'));
  process.env.HOME = home;
  delete process.env.DREAMCONTEXT_DESKTOP;
  spawned.length = 0;
  setCloudPhaseSource(() => 'active');
  // The trip's root (a laptop path, mirrored at the same path here): the only place a cloud agent runs.
  setCloudTripRootsSource(() => [join(home, 'proj')]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  setCloudPhaseSource(() => 'sealed');
  setCloudTripRootsSource(() => []);
  rmSync(home, { recursive: true, force: true });
});

describe('cloud agent spawn (AC19)', () => {
  it('spawns as dcuser through setpriv with only the allow-listed env and the chosen account', () => {
    // The registry arrives with the global set (in the cloud the server itself never writes it).
    writeClaudeAccounts([account('first', true), account('second', false)], home);
    process.env.DREAMCONTEXT_CLOUD = '1';
    process.env.GITHUB_TOKEN = 'gh-secret';
    process.env.DC_HF_TRANSFER_SECRET = 'transfer-secret';
    process.env.DC_HF_ORIGIN = 'https://x-8080.app.github.dev';
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project, { account: 'second' });
    expect(spawned).toHaveLength(1);
    const s = spawned[0];
    expect(s.file).toBe('/usr/bin/setpriv');
    expect(s.args).toContain('--reuid=dcuser');
    expect(s.args).toContain('--ambient-caps=-all');
    expect(s.args.slice(s.args.indexOf('--') + 1, s.args.indexOf('--') + 3)).toEqual(['/bin/bash', '-ilc']);
    expect(s.opts.detached).toBe(true);
    const env = s.opts.env ?? {};
    expect(env.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('second', home));
    expect(env.SHELL).toBe('/bin/bash');
    expect(env.USER).toBe('dcuser');
    for (const k of Object.keys(env)) {
      expect(k).not.toMatch(/^(DC_HF_|GITHUB_TOKEN|GH_TOKEN|CODESPACE)/);
    }
    const values = Object.values(env).join('\n');
    expect(values).not.toContain('gh-secret');
    expect(values).not.toContain('transfer-secret');
    expect(values).not.toContain(sandboxDirFor('first', home));
  });

  it('the preferred account (even account #0 on the laptop) runs on its own cloud sandbox', () => {
    writeClaudeAccounts([{ ...account('primary', true), configDir: null }], home);
    process.env.DREAMCONTEXT_CLOUD = '1';
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project);
    expect(spawned[0].opts.env?.CLAUDE_CONFIG_DIR).toBe(sandboxDirFor('primary', home));
  });
});

describe('cloud account registry write (dcserver never writes into dcuser\'s tree)', () => {
  it('goes through the worker: a /bin/sh atomic write spawned as dcuser', () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    writeClaudeAccounts([account('first', true)], home);
    return Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(spawned).toHaveLength(1);
      expect(spawned[0].file).toBe('/usr/bin/setpriv');
      const argv = spawned[0].args;
      expect(argv.slice(argv.indexOf('--') + 1)).toEqual(expect.arrayContaining(['/bin/sh', '-c']));
      expect(argv.some((a) => a.startsWith(join(home, '.dreamcontext', 'claude-accounts.json')))).toBe(true);
      spawned[0].child.emit('close', 0, null);
    });
  });
});

describe('cloud account registry: each caller learns the fate of ITS write', () => {
  it('a failed write rejects its own promise, the next one resolves on its own', async () => {
    const { setPreferredClaudeAccount, setAutoSwitchEnabled } = await import('../../src/lib/claude-accounts.js');
    writeClaudeAccounts([account('first', true), account('second', false)], home);
    process.env.DREAMCONTEXT_CLOUD = '1';
    const a = setPreferredClaudeAccount('second', home);
    const b = setAutoSwitchEnabled(false, home);
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned).toHaveLength(1); // serialised: the second waits for the first
    spawned[0].child.emit('close', 1, null);
    await new Promise((r) => setTimeout(r, 0));
    spawned[1].child.emit('close', 0, null); // the failed write's own temp cleanup (rm -f)
    await expect(a).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned).toHaveLength(3);
    spawned[2].child.emit('close', 0, null);
    await expect(b).resolves.toBeUndefined();
  });
});

describe('cloud phase gate', () => {
  it('a quiescing cloud spawns nothing and says why', () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    setCloudPhaseSource(() => 'quiescing');
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    const ws = open(project);
    expect(spawned).toHaveLength(0);
    expect(JSON.parse(String(ws.send.mock.calls[0][0])).code).toBe('cloud_quiescing');
  });
});

describe('laptop lock (AC6)', () => {
  it('refuses a chat inside a locked root with a clear message and spawns nothing', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    await beginGoing('trip-lock', [{ rootId: 'r-0000000000000001', path: project }], home);
    const ws = open(join(project));
    expect(spawned).toHaveLength(0);
    const frame = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(frame.code).toBe('handsfree_away');
    expect(frame.message).toMatch(/hands-free/);
    expect(ws.close).toHaveBeenCalled();
  });

  it('a chat outside the locked roots still starts', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const locked = join(home, 'proj');
    const other = join(home, 'other');
    mkdirSync(locked, { recursive: true });
    mkdirSync(other, { recursive: true });
    await beginGoing('trip-lock', [{ rootId: 'r-0000000000000001', path: locked }], home);
    open(other);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].opts.detached).toBe(true);
  });
});

describe('cutLiveChats (AC12)', () => {
  /** process.kill stand-in: the group stays alive until SIGKILL, whatever its leader does. */
  function fakeGroupKill() {
    let groupAlive = true;
    const spy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig?: string | number) => {
      if (sig === 0 || sig === undefined) {
        if (!groupAlive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return true;
      }
      if (sig === 'SIGKILL') groupAlive = false;
      return true;
    }) as typeof process.kill);
    return spy;
  }

  it('SIGTERMs the whole group, still SIGKILLs it after the grace when the leader already exited, resolves once all are gone (D22)', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    vi.useFakeTimers();
    const kill = fakeGroupKill();
    try {
      const project = join(home, 'proj');
      mkdirSync(project, { recursive: true });
      const id = '6f1c2e9a-2222-4a5b-8c9d-0123456789ab';
      open(project, { sessionId: id });
      expect(liveChatsSnapshot().map((e) => [e.conversationId, e.projectRoot])).toContainEqual([id, project]);
      const child = spawned[0].child;

      let done: string[] | null = null;
      const p = cutLiveChats((e) => e.projectRoot === project).then((ids) => { done = ids; });
      await vi.advanceTimersByTimeAsync(10);
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      // The leader goes; a grandchild in its group keeps running.
      child.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(CUT_KILL_GRACE_MS - 100);
      expect(done).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(100);
      await p;
      expect(done).toEqual([id]);
    } finally {
      kill.mockRestore();
    }
  });

  it('a draining child (its client said goodbye) stays listed as running and cuttable until it exits (D22)', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    vi.useFakeTimers();
    const kill = fakeGroupKill();
    try {
      const project = join(home, 'proj');
      mkdirSync(project, { recursive: true });
      const id = '6f1c2e9a-5555-4a5b-8c9d-0123456789ab';
      const ws = open(project, { sessionId: id });
      const child = spawned[0].child;
      ws.emit('message', JSON.stringify({ type: 'end' }));
      ws.emit('close');
      expect(child.stdin.end).toHaveBeenCalled();
      const snap = liveChatsSnapshot().find((e) => e.conversationId === id);
      expect(snap).toMatchObject({ draining: true, busy: true, projectRoot: project });
      const p = cutLiveChats((e) => e.projectRoot === project);
      await vi.advanceTimersByTimeAsync(CUT_KILL_GRACE_MS + 200);
      child.emit('close', null, 'SIGKILL');
      expect(await p).toEqual([id]);
      expect(liveChatsSnapshot().some((e) => e.conversationId === id)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it('cuts nothing that does not match', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project, { sessionId: '6f1c2e9a-3333-4a5b-8c9d-0123456789ab' });
    expect(await cutLiveChats((e) => e.projectRoot === '/somewhere/else')).toEqual([]);
  });
});

describe('GET /api/agent/file in the cloud (AC19: project root only, grants refused, no symlinks)', () => {
  interface Out { status: number; body: string }
  async function getFile(contextRoot: string, path: string): Promise<Out> {
    let status = 0;
    let body = '';
    const res = {
      setHeader() { /* headers are not under test */ },
      writeHead(code: number) { status = code; return res; },
      end(b?: string | Buffer) { body = b === undefined ? '' : String(b); },
    } as unknown as import('node:http').ServerResponse;
    const req = { url: `/api/agent/file?path=${encodeURIComponent(path)}`, headers: { host: 'x' }, method: 'GET' } as unknown as import('node:http').IncomingMessage;
    await handleAgentFile(req, res, {}, contextRoot);
    return { status, body };
  }

  let project: string;
  let ctx: string;
  let secret: string;
  beforeEach(() => {
    project = join(home, 'proj');
    ctx = join(project, '_dream_context');
    mkdirSync(join(ctx, 'state'), { recursive: true });
    writeFileSync(join(project, 'notes.md'), '# hello\n');
    // Stands in for /workspaces/dc-server/auth.json: outside the project.
    mkdirSync(join(home, 'dc-server'), { recursive: true });
    secret = join(home, 'dc-server', 'auth.json');
    writeFileSync(secret, '{"transferSha256":"SECRET"}');
    // The agent (dcuser) plants a grant for it in the dcuser-writable vault state.
    writeFileSync(join(ctx, 'state', '.file-grants.json'), JSON.stringify({ paths: [secret, join(home, 'dc-server')] }));
    setWorkerInProcessForTests(true);
  });
  afterEach(() => setWorkerInProcessForTests(false));

  it('a planted grant is ignored: outside the project is refused, never needs_grant', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    const r = await getFile(ctx, secret);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('outside_project');
    expect(r.body).not.toContain('SECRET');
    const dir = await getFile(ctx, join(home, 'dc-server'));
    expect(dir.status).toBe(403);
    expect(dir.body).not.toContain('auth.json');
  });

  it('a symlink at the final path is refused', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    symlinkSync(secret, join(project, 'innocent.md'));
    const r = await getFile(ctx, 'innocent.md');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe('symlink_refused');
    expect(r.body).not.toContain('SECRET');
    // Even a link that stays inside the project is refused at the final path (no swap race).
    symlinkSync(join(project, 'notes.md'), join(project, 'alias.md'));
    const inside = await getFile(ctx, 'alias.md');
    expect(inside.status).toBe(403);
    expect(JSON.parse(inside.body).error).toBe('symlink_refused');
  });

  it('a file and a folder inside the project are served (read as the worker)', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    const r = await getFile(ctx, 'notes.md');
    expect(r.status, r.body).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ type: 'markdown', content: '# hello\n' });
    const d = await getFile(ctx, '.');
    expect(d.status, d.body).toBe(200);
    expect(JSON.parse(d.body).type).toBe('dir');
    expect(JSON.parse(d.body).entries.map((e: { name: string }) => e.name)).toContain('notes.md');
  });

  it('the laptop is unchanged: a real grant still serves the granted file', async () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const r = await getFile(ctx, secret);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).content).toContain('SECRET');
    const ungranted = join(home, 'other.txt');
    writeFileSync(ungranted, 'x');
    const n = await getFile(ctx, ungranted);
    expect(n.status).toBe(403);
    expect(JSON.parse(n.body).error).toBe('needs_grant');
  });
});

/** The claude argv a spawn's login-shell script really yields: bash itself parses it. */
async function argvOfScript(script: string): Promise<string[]> {
  const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const m = /^(?:cd -- '[^']*' && )?exec claude /.exec(script);
  expect(m).not.toBeNull();
  const printer = `printargs() { for a in "$@"; do printf '%s\\0' "$a"; done; }; printargs ${script.slice(m![0].length)}`;
  // A timeout and empty stdin: a mis-quoted script (backticks in the briefing prose run as
  // commands under double quotes) must fail here, never hang.
  const r = spawnSync('/bin/bash', ['-c', printer], { encoding: 'utf8', input: '', timeout: 15_000 });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').slice(0, -1);
}

describe('smoke #4: what the cloud child (dcuser) must read is never a dcserver 0600 file', () => {
  it('--settings carries the carve-outs INLINE and the briefing rides --append-system-prompt; no server tmp file at all', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    writeClaudeAccounts([account('first', true)], home);
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project);
    const script = spawned[0].args[spawned[0].args.length - 1];
    expect(script).not.toMatch(/dreamcontext-chat-(settings|mode|surface)-/); // no file handed to the child
    const argv = await argvOfScript(script);
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]);
    expect(settings).toMatchObject(autoModeSettings()); // the carve-outs arrive intact
    expect(argv).not.toContain('--append-system-prompt-file');
    expect(argv[argv.indexOf('--append-system-prompt') + 1].startsWith(CHAT_SURFACE_BRIEFING)).toBe(true); // + the mode's brief
  });

  it('the laptop keeps its files (unchanged behaviour)', async () => {
    writeClaudeAccounts([account('first', true)], home);
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project);
    const script = spawned[0].args[spawned[0].args.length - 1];
    expect(script).toMatch(/"--settings" "[^"]*dreamcontext-chat-settings-[0-9a-f-]+\.json"/);
    expect(script).toMatch(/"--append-system-prompt-file" "[^"]*dreamcontext-chat-surface-[0-9a-f-]+\.md"/);
  });

  it('the mode note runs as a self-contained command (no file): any content comes back byte for byte', async () => {
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const note = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: "it's \"plan\" now; $HOME `x` ğüş\nline 2" } });
    const cmd = inlineModeNoteCommand(note);
    expect(cmd).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d$/);
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
    expect(r.stdout).toBe(note);
  });

  it('a deferred prompt is parked in dcuser\'s work dir (group-readable, fresh), where its hook can read AND delete it', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    process.env.DC_HF_SERVER_DIR = join(home, 'dc-server');
    mkdirSync(join(home, 'dc-work'), { recursive: true });
    writeClaudeAccounts([account('first', true)], home);
    const project = join(home, 'proj');
    mkdirSync(project, { recursive: true });
    open(project, { initialPrompt: 'take the next task', deferPrompt: true });
    const parked = spawned[0].opts.env?.DREAMCONTEXT_DEFERRED_PROMPT ?? '';
    expect(parked.startsWith(join(home, 'dc-work', 'dreamcontext-deferred-'))).toBe(true);
    const { readFileSync, statSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    expect(readFileSync(parked, 'utf8')).toBe('take the next task');
    expect(statSync(parked).mode & 0o777).toBe(0o640);
  });
});

describe('the error card shows the real error, not the login shell\'s job-control noise', () => {
  it('drops bash\'s two lines, keeps everything else', () => {
    const stderr = [
      'bash: cannot set terminal process group (-1): Inappropriate ioctl for device',
      'bash: no job control in this shell',
      "Error processing settings: EACCES: permission denied, open '/tmp/x.json'",
    ].join('\n');
    expect(withoutShellJobControlNoise(stderr).trim()).toBe("Error processing settings: EACCES: permission denied, open '/tmp/x.json'");
    expect(withoutShellJobControlNoise('bash: no job control in this shell\n').trim()).toBe('');
    expect(withoutShellJobControlNoise('a real bash: error line')).toBe('a real bash: error line');
  });

  it('the session\'s error frame carries only the real error (cloud and laptop)', () => {
    for (const cloud of [true, false]) {
      spawned.length = 0;
      if (cloud) process.env.DREAMCONTEXT_CLOUD = '1'; else delete process.env.DREAMCONTEXT_CLOUD;
      writeClaudeAccounts([account('first', true)], home);
      const project = join(home, 'proj');
      mkdirSync(project, { recursive: true });
      const ws = open(project);
      const child = spawned[0].child;
      child.stderr.emit('data', Buffer.from('bash: cannot set terminal process group (-1): Inappropriate ioctl for device\nbash: no job control in this shell\nError processing settings: EACCES\n'));
      child.emit('close', 1);
      const frames = ws.send.mock.calls.map((c) => JSON.parse(String(c[0])) as { type: string; subtype?: string; message?: string });
      const err = frames.find((f) => f.type === '_meta' && f.subtype === 'error');
      expect(err?.message).toBe('Error processing settings: EACCES');
    }
  });
});

describe('smoke #5 (Critical): a cloud chat runs ONLY in a trip root, never in the codespace\'s checkout', () => {
  const sentErrors = (ws: FakeWs) => ws.send.mock.calls.map((c) => JSON.parse(String(c[0])) as { type: string; code?: string; message?: string }).filter((f) => f.type === 'dc_meta');

  it('the trip\'s project spawns, and the script itself goes to the root (a shell init that changes directory cannot move it)', async () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    writeClaudeAccounts([account('first', true)], home);
    const project = join(home, 'proj');
    mkdirSync(join(project, 'sub'), { recursive: true });
    open(project);
    expect(spawned).toHaveLength(1);
    const script = spawned[0].args[spawned[0].args.length - 1];
    expect(script.startsWith(`cd -- '${project}' && exec claude `)).toBe(true);
    // What claude's cwd really is, after a login shell that cd'd somewhere else first.
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const probe = `cd / && ${script.replace(/exec claude .*$/s, 'pwd -P')}`;
    const { realpathSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    expect(spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8' }).stdout.trim()).toBe(realpathSync(project));
    // A folder inside the trip root is fine too.
    open(join(project, 'sub'));
    expect(spawned).toHaveLength(2);
  });

  it('the codespace\'s own checkout, a look-alike sibling, and a cloud with no trip are refused with a clear message; nothing spawns', () => {
    process.env.DREAMCONTEXT_CLOUD = '1';
    writeClaudeAccounts([account('first', true)], home);
    const checkout = join(home, 'dreamcontext-handsfree');
    const sibling = join(home, 'proj2');
    for (const d of [join(home, 'proj'), checkout, sibling]) mkdirSync(d, { recursive: true });
    for (const where of [checkout, sibling]) {
      const ws = open(where);
      const err = sentErrors(ws).find((f) => f.code === 'cloud_not_trip');
      expect(err?.message).toMatch(/not part of the trip on this cloud machine/);
      expect(ws.close).toHaveBeenCalled();
    }
    setCloudTripRootsSource(() => []);
    const ws = open(join(home, 'proj'));
    expect(sentErrors(ws).find((f) => f.code === 'cloud_not_trip')?.message).toMatch(/No trip is on this cloud machine/);
    expect(spawned).toEqual([]);
  });

  it('a request naming no vault or an unknown one resolves to NO root (refused at the upgrade, never a default root)', async () => {
    const { resolveVaultProjectRoot } = await import('../../src/server/routes/agent-spawn-shared.js');
    expect(resolveVaultProjectRoot(null)).toBeNull();
    expect(resolveVaultProjectRoot('')).toBeNull();
    expect(resolveVaultProjectRoot('dreamcontext-handsfree')).toBeNull(); // not registered
  });

  it('the laptop is unchanged: no cd prefix, no trip check', () => {
    writeClaudeAccounts([account('first', true)], home);
    const elsewhere = join(home, 'anywhere');
    mkdirSync(elsewhere, { recursive: true });
    open(elsewhere);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args[spawned[0].args.length - 1].startsWith('exec claude ')).toBe(true);
  });
});

