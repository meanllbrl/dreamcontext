// AC17 (SMOKE #7, #8): after a long stop the first cloud `claude` against an account dir has to
// refresh an expired token, which outlasts the 10 s sign-in check. Killing it there left the CLI's
// refresh lock held and the phone's next chat turns failed with "another Claude Code process is
// refreshing it". These pin the fix with a REAL child (a fake `claude` on PATH that holds a lock
// file while it sleeps): the cloud never kills it mid-run, a chat on that account waits for it,
// other accounts never wait, the boot warm-up goes one account at a time, and the laptop still
// kills a hung check exactly as before.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitClaudeAccountIdle, claudeAuthStatus, isClaudeAccountDirBusy, resetClaudeAuthCache, warmCloudAccountLogins,
} from '../../src/lib/claude-auth.js';
import { sandboxDirFor, writeClaudeAccounts } from '../../src/lib/claude-accounts.js';
import { setSameUidWorkerForTests } from '../../src/server/cloud-mode.js';
import { awaitCloudChatAccount } from '../../src/server/routes/agent-chat.js';
import { probeAccountUsage } from '../../src/lib/claude-usage-probe.js';

const STUB = `#!/bin/bash
kind=auth; [ "$1" = "-p" ] && kind=usage
id=$(basename "$CLAUDE_CONFIG_DIR")
echo "start $kind $id" >> "$HOME/stub.log"
s=0; [ -f "$CLAUDE_CONFIG_DIR/stub-sleep" ] && s=$(cat "$CLAUDE_CONFIG_DIR/stub-sleep")
touch "$CLAUDE_CONFIG_DIR/refresh.lock"
sleep "$s"
rm -f "$CLAUDE_CONFIG_DIR/refresh.lock"
echo "end $kind $id" >> "$HOME/stub.log"
echo '{"loggedIn": true, "email": "someone@example.invalid"}'
`;

const saved: Record<string, string | undefined> = {};
let home: string;

function account(id: string, preferred = false) {
  return { id, accountUuid: '', email: `${id}@example.invalid`, organizationUuid: '', organizationName: '', tier: 'max', configDir: join(home, '.dreamcontext', 'claude-accounts', id), preferred };
}

/** A registered account with a sandbox whose stub sleeps `seconds`. */
function sandbox(id: string, seconds: number): string {
  const dir = sandboxDirFor(id, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stub-sleep'), String(seconds));
  return dir;
}

const log = (): string[] => {
  const p = join(home, 'stub.log');
  return existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean) : [];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; log: ${log().join(' | ')}`);
    await sleep(25);
  }
}

beforeEach(() => {
  for (const k of ['HOME', 'PATH', 'DREAMCONTEXT_CLOUD']) saved[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'cloud-refresh-'));
  process.env.HOME = home;
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), STUB);
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  // The registry first: in the cloud the server itself never writes it.
  delete process.env.DREAMCONTEXT_CLOUD;
  writeClaudeAccounts([account('alpha', true), account('beta'), account('gamma')], home);
  resetClaudeAuthCache();
});

afterEach(async () => {
  // Let every stub this test started finish before its HOME goes.
  for (const id of ['alpha', 'beta', 'gamma']) await awaitClaudeAccountIdle(sandboxDirFor(id, home), 10_000);
  setSameUidWorkerForTests(false);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetClaudeAuthCache();
  rmSync(home, { recursive: true, force: true });
});

function cloud(): void {
  process.env.DREAMCONTEXT_CLOUD = '1';
  setSameUidWorkerForTests(true);
}

describe('cloud: a credential-refreshing claude is never killed mid-run', () => {
  it('a check past its budget resolves unknown, and the child finishes on its own', async () => {
    cloud();
    const dir = sandbox('alpha', 1.2);
    const status = await claudeAuthStatus(dir, 300);
    expect(status.loggedIn).toBeNull();
    expect(status.error).toMatch(/still running/);
    // The stub is mid-"refresh", holding its lock, and nobody killed it.
    await until(() => log().includes('start auth alpha'));
    expect(isClaudeAccountDirBusy(dir)).toBe(true);
    await until(() => log().includes('end auth alpha'));
    expect(existsSync(join(dir, 'refresh.lock'))).toBe(false);
    // Its real answer is what the next caller gets.
    await until(() => !isClaudeAccountDirBusy(dir));
    expect((await claudeAuthStatus(dir)).loggedIn).toBe(true);
  });

  it('a second check on the same dir joins the running one instead of starting a twin', async () => {
    cloud();
    const dir = sandbox('alpha', 0.8);
    await claudeAuthStatus(dir, 100);
    resetClaudeAuthCache(dir); // the usage probe's re-ask and the auth watcher both reset
    await claudeAuthStatus(dir, 100);
    await until(() => !isClaudeAccountDirBusy(dir));
    expect(log().filter((l) => l === 'start auth alpha')).toHaveLength(1);
  });
});

describe('cloud: a chat waits for its own account only', () => {
  it('a chat on the refreshing account starts after the check ends; another account does not wait', async () => {
    cloud();
    sandbox('alpha', 1.0);
    sandbox('beta', 0);
    void claudeAuthStatus(sandboxDirFor('alpha', home), 100);
    await until(() => log().includes('start auth alpha'));

    const t0 = Date.now();
    await awaitCloudChatAccount('beta');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(log()).not.toContain('end auth alpha');

    await awaitCloudChatAccount('alpha');
    expect(log()).toContain('end auth alpha');
  });

  it('the wait is bounded', async () => {
    cloud();
    sandbox('alpha', 1.5);
    void claudeAuthStatus(sandboxDirFor('alpha', home), 100);
    await until(() => log().includes('start auth alpha'));
    const t0 = Date.now();
    await awaitCloudChatAccount('alpha', 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(log()).not.toContain('end auth alpha');
  });
});

describe('cloud: the usage probe joins the same per-account queue', () => {
  it('its `claude -p /usage` starts only after the running sign-in check ends', async () => {
    cloud();
    const dir = sandbox('alpha', 0.8);
    void claudeAuthStatus(dir, 100);
    await until(() => log().includes('start auth alpha'));
    await probeAccountUsage(dir, { home });
    const lines = log();
    expect(lines.indexOf('start usage alpha')).toBeGreaterThan(lines.indexOf('end auth alpha'));
  });
});

describe('cloud boot warm-up', () => {
  it('checks each account with a sandbox one at a time, without blocking its caller', async () => {
    cloud();
    sandbox('alpha', 0.4);
    sandbox('beta', 0.4); // gamma has no sandbox: skipped
    const warm = warmCloudAccountLogins(home);
    // Returned at once; nothing has finished yet.
    expect(log()).not.toContain('end auth alpha');
    await warm;
    expect(log()).toEqual(['start auth alpha', 'end auth alpha', 'start auth beta', 'end auth beta']);
  });

  it('does nothing on the laptop', async () => {
    sandbox('alpha', 0);
    await warmCloudAccountLogins(home);
    await sleep(200);
    expect(log()).toEqual([]);
  });
});

describe('laptop: unchanged', () => {
  it('a hung check is killed at its budget', async () => {
    const dir = sandbox('alpha', 1.0);
    const status = await claudeAuthStatus(dir, 300);
    expect(status.loggedIn).toBeNull();
    expect(status.error).toMatch(/timed out/);
    await until(() => log().includes('start auth alpha'));
    await sleep(1500);
    expect(log()).not.toContain('end auth alpha');
    expect(isClaudeAccountDirBusy(dir)).toBe(false);
  });
});
