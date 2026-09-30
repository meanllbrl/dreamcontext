/**
 * `dreamcontext notify` (src/cli/commands/notify.ts). Every case drives `runNotify` with an
 * injected home, platform, builder and poster: nothing here compiles a real applet, posts a
 * real banner, or reads the developer's real vault registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runNotify, readHookPayload, type NotifyDeps } from '../../src/cli/commands/notify.js';
import { notifierAppPath, NOTIFY_SOUND_OK } from '../../src/lib/automations/notifier.js';
import { createProgram } from '../../src/cli/program.js';

const ID = '0b1d3c97-6daf-4943-96d5-8614e7d0960e';
let home: string;
let project: string;
let post: ReturnType<typeof vi.fn>;
let build: ReturnType<typeof vi.fn>;
let logs: string[];

function deps(over: Partial<NotifyDeps> = {}): NotifyDeps {
  return { home, cwd: project, platform: 'darwin', post, build, log: (l) => logs.push(l), ...over };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-notify-cli-home-'));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-notify-cli-proj-')));
  mkdirSync(join(project, '_dream_context', 'automations'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'Kitap Ağacı', path: project }] }));
  post = vi.fn(() => true);
  // A build that "succeeds" by creating the bundle directory, like the real one would.
  build = vi.fn((h: string) => { mkdirSync(notifierAppPath(h), { recursive: true }); return { built: true, path: notifierAppPath(h), reason: null }; });
  logs = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const V = 'Kitap%20A%C4%9Fac%C4%B1';

describe('the link a banner carries', () => {
  it('defaults to the Notifications window when nothing names a place', () => {
    const out = runNotify('Done', 'All good', {}, deps());
    expect(out).toMatchObject({ posted: true, link: 'dreamcontext://inbox', exitCode: 0 });
    expect(post).toHaveBeenCalledWith('Done', 'All good', home, { sound: NOTIFY_SOUND_OK, link: 'dreamcontext://inbox', openTarget: null });
  });

  it('--session opens that chat in the vault containing the cwd', () => {
    const out = runNotify('Claude finished', undefined, { session: ID }, deps({ cwd: join(project, 'src') }));
    expect(out.link).toBe(`dreamcontext://project/${V}/session/${ID}`);
  });

  it('--vault names the vault explicitly and alone opens that project', () => {
    expect(runNotify('t', undefined, { vault: 'Kitap Ağacı' }, deps({ cwd: tmpdir() })).link).toBe(`dreamcontext://project/${V}`);
  });

  it('--automation with --file inside the brain rides ?file=, and the file is the fallback', () => {
    const doc = join(project, '_dream_context', 'automations', 'out.md');
    const out = runNotify('t', 'b', { automation: 'daily-digest', file: doc }, deps());
    expect(out.link).toBe(`dreamcontext://project/${V}/automation/daily-digest?file=automations%2Fout.md`);
    expect(post.mock.calls[0][3]).toMatchObject({ openTarget: doc });
  });

  it('--file alone inside the project opens the viewer', () => {
    const out = runNotify('t', 'b', { file: 'src/report.md' }, deps());
    expect(out.link).toBe(`dreamcontext://project/${V}/view?path=src%2Freport.md`);
    expect(out.file).toBe(join(project, 'src', 'report.md'));
  });

  it('--link is used verbatim when valid', () => {
    const link = `dreamcontext://project/${V}/page/sleep`;
    expect(runNotify('t', 'b', { link }, deps()).link).toBe(link);
  });

  it('--session-stdin reads session_id and cwd from a Claude Code hook payload, and its message as the body', () => {
    const out = runNotify('Claude is asking', undefined, { sessionStdin: true }, deps({
      cwd: tmpdir(),
      hookPayload: { session_id: ID, cwd: join(project, 'src'), hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' } as never,
    }));
    expect(out.link).toBe(`dreamcontext://project/${V}/session/${ID}`);
    expect(post.mock.calls[0][1]).toBe('Claude needs your permission to use Bash');
  });
});

describe('refusals exit 1 with the reason, and post nothing', () => {
  const cases: Array<[string, Parameters<typeof runNotify>[2], Partial<NotifyDeps>?]> = [
    ['a traversal vault', { vault: '../etc' }],
    ['an unregistered vault', { vault: 'nope' }],
    ['a traversal session id', { session: '../../evil' }],
    ['a bad automation slug', { automation: 'Not A Slug' }],
    ['an invalid --link', { link: 'dreamcontext://project/../x' }],
    ['--link with --session', { link: 'dreamcontext://inbox', session: ID }],
    ['--session with --automation', { session: ID, automation: 'a' }],
    ['--session outside any registered vault', { session: ID }, { cwd: tmpdir() }],
    ['--session-stdin without a session_id', { sessionStdin: true }, { hookPayload: { cwd: '/x' } }],
    ['a sound that is not a sound name', { sound: '../x;rm' }],
  ];
  for (const [name, opts, extra] of cases) {
    it(name, () => {
      const out = runNotify('t', 'b', opts, deps(extra));
      expect(out.exitCode).toBe(1);
      expect(out.posted).toBe(false);
      expect(out.reason).toBeTruthy();
      expect(post).not.toHaveBeenCalled();
    });
  }

  it('an empty title', () => {
    expect(runNotify('  ', 'b', {}, deps()).exitCode).toBe(1);
  });

  it('exits 1 when the notifier did not accept the banner', () => {
    post.mockReturnValue(false);
    expect(runNotify('t', 'b', {}, deps())).toMatchObject({ posted: false, exitCode: 1 });
  });

  it('exits 1 when the applet cannot be built', () => {
    build.mockReturnValue({ built: false, path: '', reason: 'osacompile missing' });
    const out = runNotify('t', 'b', {}, deps());
    expect(out).toMatchObject({ posted: false, exitCode: 1 });
    expect(out.reason).toContain('osacompile missing');
  });
});

describe('platform and applet lifecycle', () => {
  it('is a no-op that exits 0 off macOS, building nothing', () => {
    const out = runNotify('t', 'b', {}, deps({ platform: 'linux' }));
    expect(out).toMatchObject({ posted: false, exitCode: 0 });
    expect(build).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('builds the applet on first use and says the permission line then', () => {
    runNotify('t', 'b', {}, deps());
    expect(build).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/permission/);
  });

  it('rebuilds a stale applet quietly (no permission line: the grant survives a rebuild)', () => {
    mkdirSync(notifierAppPath(home), { recursive: true }); // present, no sha stamp => stale
    runNotify('t', 'b', {}, deps());
    expect(build).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([]);
  });

  it('--sound none posts silently', () => {
    runNotify('t', 'b', { sound: 'none' }, deps());
    expect(post.mock.calls[0][3]).toMatchObject({ sound: undefined });
  });
});

describe('readHookPayload', () => {
  it('parses a JSON payload and returns null for garbage', async () => {
    expect(await readHookPayload(Readable.from([Buffer.from(JSON.stringify({ session_id: ID, cwd: '/p' }))]))).toEqual({ session_id: ID, cwd: '/p' });
    expect(await readHookPayload(Readable.from([Buffer.from('not json')]))).toBeNull();
  });
});

describe('registration', () => {
  it('is a top-level command with every documented flag', () => {
    const cmd = createProgram().commands.find((c) => c.name() === 'notify');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    for (const f of ['--vault', '--session', '--automation', '--file', '--link', '--session-stdin', '--sound']) {
      expect(flags).toContain(f);
    }
  });
});
