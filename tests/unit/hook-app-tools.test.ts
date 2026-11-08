/**
 * The prompt hook's `[App tools on this Mac]` block through the built CLI (`hook user-prompt-submit`,
 * app-araclari plan r3 §3b, criterion 7): an installed app's tool is named with its `apps do` call,
 * in every recall mode (raw, off), never in a background sleep; nothing for an unrelated prompt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliWithStdin } from '../helpers/cli-stdin.js';
import { makeTeamProject, type TeamProject } from '../../eval/super-team-routing/setup.js';
import { registerApp } from '../../src/lib/apps/registry.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

let root: string;
let tp: TeamProject;

function hook(prompt: string, extra: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: tp.home, DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_RECALL_MODE: 'raw', DREAMCONTEXT_AUTO_UPGRADE: '0',
    DREAMCONTEXT_SERVER_PID: String(process.pid),
  };
  delete env.DREAMCONTEXT_TEAM_ROUTE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.DREAMCONTEXT_AUTO_SLEEP;
  delete env.DREAMCONTEXT_AUTOMATION_SLUG;
  Object.assign(env, extra);
  return runCliWithStdin(CLI, ['hook', 'user-prompt-submit'], JSON.stringify({ session_id: 'sess-app', prompt }), { cwd: tp.proj, env, timeout: 20_000, withStderr: true });
}
const appLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('→ APP TOOL') || l.startsWith('→ The project has the app'));

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('build the CLI first (npm run build:cli)');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-hook-app-')));
  tp = makeTeamProject(root, { team: false });
  const appRoot = join(`${tp.proj}-apps`, 'yuk-izleme');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, 'dreamcontext-app.json'), JSON.stringify({
    slug: 'yuk-izleme', name: 'Yük İzleme', backend: { command: 'node s.mjs', health: '/health' },
    actions: [
      { id: 'snapshot', title: 'Tek ölçüm', method: 'GET', path: '/api/snapshot', does: 'Measures the machine load right now: CPU, memory and the busiest processes.', topics: ['load', 'cpu', 'yük'] },
      { id: 'notify-test', title: 'Deneme bildirimi', method: 'POST', path: '/api/notify-test', does: 'Sends a test notification.', topics: ['notification', 'bildirim'] },
    ],
  }));
  registerApp(tp.home, { projectRoot: tp.proj, vault: 'orbit', slug: 'yuk-izleme', name: 'Yük İzleme', root: appRoot });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('hook user-prompt-submit: app tools on this Mac', () => {
  it('names the reading tool and its call', () => {
    const out = hook('what is the cpu load on this machine right now?');
    expect(out).toContain('[App tools on this Mac]');
    expect(appLines(out)[0]).toContain('yuk-izleme › snapshot');
    expect(appLines(out)[0]).toContain('dreamcontext apps do yuk-izleme snapshot --json');
  });

  it('a changing tool asks for the owner\'s yes first', () => {
    expect(appLines(hook('send me a test notification'))[0]).toContain('--confirm only after the owner says yes in this chat');
  });

  it('works with recall switched off, and not in a background sleep', () => {
    expect(appLines(hook('cpu load right now', { DREAMCONTEXT_RECALL_MODE: 'off' })).length).toBe(1);
    expect(appLines(hook('cpu load right now', { DREAMCONTEXT_AUTO_SLEEP: '1' }))).toEqual([]);
  });

  it('nothing for an unrelated prompt', () => {
    expect(appLines(hook('rename the variable in the parser'))).toEqual([]);
  });
});
