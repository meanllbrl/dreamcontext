/**
 * Per-tool account limit rules (src/lib/account-rules.ts) and their routes.
 *
 * The load-bearing promises:
 *  - Codex reads Claude's switch policy until it has its own (today's behaviour is kept);
 *  - a Codex edit never writes `claude-accounts.json` (byte-identical);
 *  - once pinned, a Claude edit never moves Codex, through the old routes or the new one;
 *  - "When every account is out" defaults to Stop for both tools;
 *  - a bad value is a 422, never a silent default.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountRulesFilePath, claudeRules, codexRules, parseRulesPatch, pinCodexRules, setCodexRules,
} from '../../src/lib/account-rules.js';
import {
  claudeAccountsFilePath, setAgentThreshold, setAutoSwitchEnabled, setSwitchPolicy, writeClaudeAccounts,
} from '../../src/lib/claude-accounts.js';
import {
  handleAgentAccountsAgentThreshold, handleAgentAccountsAutoSwitch, handleAgentAccountsRulesGet,
  handleAgentAccountsRulesSet, handleAgentAccountsSwitchPolicy,
} from '../../src/server/routes/agent-accounts.js';
import { pickCodexRunAccount } from '../../src/lib/automations/codex-account.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-account-rules-'));
const REAL_HOME = process.env.HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  writeClaudeAccounts([], HOME);
});

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function call(handler: Handler, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  Object.assign(req as any, {
    url, method,
    headers: { host: '127.0.0.1:1234', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    setHeader() { return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  await handler(req, res);
  return captured;
}

const claudeFile = () => readFileSync(claudeAccountsFilePath(HOME), 'utf-8');

describe('codexRules reads through to Claude until pinned', () => {
  it('with no rules file, Codex follows every Claude value and both stop at exhaustion', () => {
    setSwitchPolicy({ strategy: 'sequential', weights: { session: 4, weekly: 1, order: 2 } }, HOME);
    setAgentThreshold(70, HOME);
    const c = codexRules(HOME);
    expect(c.strategy).toBe('sequential');
    expect(c.weights).toEqual({ session: 4, weekly: 1, order: 2 });
    expect(c.agentThreshold).toBe(70);
    expect(c.autoSwitch).toBe(true);
    expect(c.onExhausted).toBe('stop');
    expect(claudeRules(HOME).onExhausted).toBe('stop');
    expect(existsSync(accountRulesFilePath(HOME))).toBe(false);
  });

  it('pinCodexRules copies Claude once; a later Claude edit does not move Codex', () => {
    setAgentThreshold(70, HOME);
    pinCodexRules(HOME);
    setAgentThreshold(90, HOME);
    setSwitchPolicy({ strategy: 'sequential' }, HOME);
    expect(codexRules(HOME).agentThreshold).toBe(70);
    expect(codexRules(HOME).strategy).toBe('score');
  });
});

describe('a Codex edit never touches claude-accounts.json', () => {
  it('is byte-identical after every Codex rule', () => {
    const before = claudeFile();
    setCodexRules({ autoSwitch: false }, HOME);
    setCodexRules({ strategy: 'sequential' }, HOME);
    setCodexRules({ weights: { session: 9, weekly: 9, order: 9 } }, HOME);
    setCodexRules({ agentThreshold: 60 }, HOME);
    setCodexRules({ onExhausted: 'continue' }, HOME);
    expect(claudeFile()).toBe(before);
    const c = codexRules(HOME);
    expect(c).toEqual({ autoSwitch: false, strategy: 'sequential', weights: { session: 9, weekly: 9, order: 9 }, agentThreshold: 60, onExhausted: 'continue' });
    // Claude kept its own values.
    expect(claudeRules(HOME).autoSwitch).toBe(true);
    expect(claudeRules(HOME).onExhausted).toBe('stop');
  });

  it('a new value is what the next reader sees (read at decision time, not cached)', () => {
    setCodexRules({ agentThreshold: 50 }, HOME);
    expect(codexRules(HOME).agentThreshold).toBe(50);
    setCodexRules({ agentThreshold: 95 }, HOME);
    expect(codexRules(HOME).agentThreshold).toBe(95);
  });

  it('the unattended Codex picker reads the Codex threshold (no accounts = none)', () => {
    setCodexRules({ agentThreshold: 10 }, HOME);
    expect(pickCodexRunAccount({ unattended: true, home: HOME })).toEqual({ none: true });
  });
});

describe('parseRulesPatch refuses what it cannot store', () => {
  it.each([
    [{ autoSwitch: 'yes' }, 'autoSwitch'],
    [{ strategy: 'fastest' }, 'strategy'],
    [{ weights: { order: -1 } }, 'weights.order'],
    [{ agentThreshold: 0 }, 'agentThreshold'],
    [{ agentThreshold: 80.5 }, 'agentThreshold'],
    [{ onExhausted: 'retry' }, 'onExhausted'],
    [{}, 'at least one'],
  ])('%j', (patch, msg) => {
    expect(() => parseRulesPatch(patch)).toThrow(msg);
  });
});

describe('routes', () => {
  it('GET /rules returns both tools in force', async () => {
    const out = await call(handleAgentAccountsRulesGet, 'GET', '/api/agent/accounts/rules');
    expect(out.status).toBe(200);
    expect(out.body.claude.onExhausted).toBe('stop');
    expect(out.body.codex.onExhausted).toBe('stop');
  });

  it('POST /rules {tool: codex} writes only the rules file', async () => {
    const before = claudeFile();
    const out = await call(handleAgentAccountsRulesSet, 'POST', '/api/agent/accounts/rules', { tool: 'codex', patch: { autoSwitch: false, onExhausted: 'continue' } });
    expect(out.status).toBe(200);
    expect(out.body.codex.autoSwitch).toBe(false);
    expect(out.body.codex.onExhausted).toBe('continue');
    expect(out.body.claude.autoSwitch).toBe(true);
    expect(claudeFile()).toBe(before);
  });

  it('POST /rules {tool: claude} pins Codex first, then writes Claude', async () => {
    const out = await call(handleAgentAccountsRulesSet, 'POST', '/api/agent/accounts/rules', { tool: 'claude', patch: { autoSwitch: false, agentThreshold: 65, onExhausted: 'continue' } });
    expect(out.status).toBe(200);
    expect(out.body.claude).toMatchObject({ autoSwitch: false, agentThreshold: 65, onExhausted: 'continue' });
    expect(out.body.codex).toMatchObject({ autoSwitch: true, agentThreshold: 80, onExhausted: 'stop' });
  });

  it('a bad tool or value is 422 and changes nothing', async () => {
    const before = claudeFile();
    expect((await call(handleAgentAccountsRulesSet, 'POST', '/x', { tool: 'gemini', patch: { autoSwitch: false } })).status).toBe(422);
    expect((await call(handleAgentAccountsRulesSet, 'POST', '/x', { tool: 'codex', patch: { onExhausted: 'later' } })).status).toBe(422);
    expect(claudeFile()).toBe(before);
    expect(existsSync(accountRulesFilePath(HOME))).toBe(false);
  });

  it('the old Claude routes pin Codex before writing, so Codex stays put', async () => {
    await call(handleAgentAccountsAutoSwitch, 'POST', '/api/agent/accounts/auto-switch', { enabled: false });
    await call(handleAgentAccountsSwitchPolicy, 'POST', '/api/agent/accounts/switch-policy', { strategy: 'sequential' });
    await call(handleAgentAccountsAgentThreshold, 'POST', '/api/agent/accounts/agent-threshold', { percent: 55 });
    const c = codexRules(HOME);
    expect(c.autoSwitch).toBe(true);
    expect(c.strategy).toBe('score');
    expect(c.agentThreshold).toBe(80);
    expect(claudeRules(HOME)).toMatchObject({ autoSwitch: false, strategy: 'sequential', agentThreshold: 55 });
  });

  it('setAutoSwitchEnabled without a pin still moves Codex (read-through is the old behaviour)', async () => {
    await setAutoSwitchEnabled(false, HOME);
    expect(codexRules(HOME).autoSwitch).toBe(false);
  });
});
