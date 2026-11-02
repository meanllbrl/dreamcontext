/**
 * `dreamcontext t3-run --tool antigravity` against T3's fake ACP agent: a real `runBridgeStdio`,
 * T3's real driver, the agent as a child. The fake asks before `cat server/package.json`: a read-only
 * run lets that plain read through and prints one `claude -p`-shaped document.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClaudeJson } from '../../../src/lib/automations/runner.js';
import { runT3Headless } from '../../../src/lib/t3-bridge/run.js';
import { HEADLESS_ENVELOPES, type HeadlessSurface } from '../../../src/lib/t3-bridge/headless-envelope.js';
import { antigravityProfileDir } from '../../../src/lib/antigravity-accounts.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const AGENT = join(ROOT, 'src/vendor/t3/apps/server/scripts/acp-mock-agent.ts');
const REGISTER = join(ROOT, 'scripts/t3-node-register.mjs');

function fakeAgentOnPath(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy_acp_server.par'), `#!/bin/sh\nexec "${process.execPath}" --import "${REGISTER}" "${AGENT}" "$@"\n`);
  chmodSync(join(bin, 'agy_acp_server.par'), 0o755);
  writeFileSync(join(bin, 'localharness_external'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'localharness_external'), 0o755);
  return bin;
}

const nodeMajor = Number(process.versions.node.split('.')[0]);

describe.skipIf(nodeMajor < 22)('headless Antigravity run (fake ACP agent)', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-agy-run-'));
    process.env.T3_ACP_ANTIGRAVITY = '1';
    process.env.T3_ACP_EMIT_TOOL_CALLS = '1';
    process.env.T3_ACP_REQUEST_LOG_PATH = join(dir, 'requests.ndjson');
    process.env.PATH = `${fakeAgentOnPath(dir)}:${process.env.PATH ?? ''}`;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('read-only: the plain read it asked for runs, nothing is denied, one parseable document', async () => {
    const cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    const lines: string[] = [];
    const code = await runT3Headless(
      { cwd, prompt: 'Read the package name.', surface: 'light', tool: 'antigravity' },
      { write: (l) => lines.push(l), env: process.env, home: dir, brain: null },
    );
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]!) as { dc_tool: string; permission_denials: unknown[] };
    expect(doc.dc_tool).toBe('antigravity');
    expect(doc.permission_denials).toEqual([]);
    const parsed = parseClaudeJson(lines[0]!);
    expect(parsed.parsed).toBe(true);
    expect(code).toBe(parsed.isError ? 1 : 0);
    const log = readFileSync(join(dir, 'requests.ndjson'), 'utf-8');
    expect(log).toContain('session/prompt');
  }, 60_000);

  // Night lane 2, W5: every unattended surface Antigravity takes, on the fake agent (the only
  // account is out of quota: no real turn). Each prints one parseable document on Antigravity,
  // and the account profile carries our roles as its sub-agents (antigravity-roles.ts).
  it('every surface with an Antigravity flavour runs on the fake agent, and the roles are in the profile', async () => {
    const cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    const surfaces = (Object.keys(HEADLESS_ENVELOPES) as HeadlessSurface[]).filter((x) => HEADLESS_ENVELOPES[x].antigravity);
    expect(surfaces).toEqual(expect.arrayContaining(['automation', 'agent', 'light', 'verdict', 'sleep', 'super-child', 'approval-question', 'peer', 'ask', 'ask-write']));
    for (const surface of surfaces) {
      const lines: string[] = [];
      await runT3Headless(
        { cwd, prompt: `Say what the ${surface} run would do.`, surface, tool: 'antigravity' },
        { write: (l) => lines.push(l), env: process.env, home: dir, brain: null },
      );
      expect(lines, surface).toHaveLength(1);
      expect(JSON.parse(lines[0]!).dc_tool, surface).toBe('antigravity');
      expect(parseClaudeJson(lines[0]!).parsed, surface).toBe(true);
    }
    const agents = join(antigravityProfileDir('primary', dir), 'config', 'plugins', 'dreamcontext', 'agents');
    expect(readdirSync(agents)).toEqual(expect.arrayContaining(['sleep-state.md', 'goal-planner.md', 'reviewer.md']));
    // A surface that stays on Claude is refused before anything starts.
    const refused: string[] = [];
    const code = await runT3Headless({ cwd, prompt: 'x', surface: 'board-agent', tool: 'antigravity' }, { write: (l) => refused.push(l), env: process.env, home: dir, brain: null });
    expect(code).not.toBe(0);
  }, 240_000);
});
