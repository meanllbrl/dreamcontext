/** Track T W4: a Super Agent's delegated child on Codex, and the terminal on an account. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { delegateArgs } from '../../dashboard/src/components/sleepy/super/superHandover';
import { parseJob } from '../../src/lib/super/jobs.js';
import { codexLeanMcpArgs, codexStrictArgs, parseCodexMcpList } from '../../src/lib/t3-bridge/launch.js';
import { runT3Headless } from '../../src/lib/t3-bridge/run.js';
import { leanServerCommand } from '../../src/lib/super/lean-exec.js';
import { codexEnvGateReady } from '../../src/lib/t3-bridge/env-gate.js';
import { HEADLESS_ENVELOPES } from '../../src/lib/t3-bridge/headless-envelope.js';
import { bridgeChatScript } from '../../src/lib/t3-bridge/spawn.js';
import { codexExecLine } from '../../src/server/routes/agent-terminal.js';
import { codexTerminalEnv } from '../../src/lib/codex-accounts.js';

describe('a delegated job on Codex', () => {
  it('carries the tool from the verb to the window, and only a real tool', () => {
    const ok = parseJob({ prompt: 'Do it', tool: 'codex' });
    expect('job' in ok && ok.job.tool).toBe('codex');
    const plain = parseJob({ prompt: 'Do it' });
    expect('job' in plain && plain.job.tool).toBeUndefined();
    expect(parseJob({ prompt: 'Do it', tool: 'other' })).toEqual({ error: 'tool must be claude or codex' });
    const d = delegateArgs({ prompt: 'Do it', tool: 'codex' });
    expect(d.ok && d.tool).toBe('codex');
    const none = delegateArgs({ prompt: 'Do it', tool: 'x' });
    expect(none.ok && none.tool).toBeUndefined();
  });

  it('never puts a token on a command line: the server starts from the 0600 file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-lean-'));
    const path = join(dir, 'lean.json');
    writeFileSync(path, JSON.stringify({ mcpServers: {
      slack: { command: 'npx', args: ['slack-mcp', '--key=SECRET-ARG'], env: { TOKEN: 'SECRET-ENV' } },
      remote: { url: 'https://example.test/mcp' },
      'bad name': { command: 'x' },
    } }));
    const out = codexLeanMcpArgs(path, { node: '/n', cli: '/c' });
    expect(out).toContain('mcp_servers.slack.command');
    expect(out).toContain('lean-exec');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('npx');
    expect(out).not.toContain('remote');
    expect(out).not.toContain('bad name');
    expect(codexLeanMcpArgs(join(dir, 'missing.json'), { node: '/n', cli: '/c' })).toBe('');
    expect(leanServerCommand(path, 'slack')).toEqual({ command: 'npx', args: ['slack-mcp', '--key=SECRET-ARG'], env: { TOKEN: 'SECRET-ENV' } });
    expect(leanServerCommand(path, 'constructor')).toBeNull();
    expect(leanServerCommand(path, 'remote')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts the subset before the variadic roots', () => {
    const script = bridgeChatScript({ tool: 'codex', model: 'gpt-5.6-terra', effort: '', mode: 'auto', pane: '11111111-2222-4333-8444-555555555555', resume: '', briefingArg: [], node: '/n', cli: '/c', mcpConfig: '/tmp/lean.json', extraRoots: ['/r'] })!;
    expect(script.indexOf('--mcp-config')).toBeGreaterThan(0);
    expect(script.indexOf('--mcp-config')).toBeLessThan(script.indexOf('--extra-root'));
  });
});

describe('a narrow Codex surface', () => {
  it('switches off every server Codex lists but its own, and web search', () => {
    const listed = parseCodexMcpList(JSON.stringify([{ name: 'outer' }, { name: 'slack' }, { name: 'dreamcontext' }]));
    const out = codexStrictArgs(listed, ['dreamcontext', 'slack'])!;
    expect(out).toContain('mcp_servers.outer.enabled=false');
    expect(out).not.toContain('mcp_servers.slack');
    expect(out).not.toContain('mcp_servers.dreamcontext');
    expect(out).toContain('web_search');
    expect(HEADLESS_ENVELOPES['super-child'].strict && HEADLESS_ENVELOPES.sleep.strict && HEADLESS_ENVELOPES.light.strict).toBe(true);
  });

  it('refuses rather than leave a server on', () => {
    expect(codexStrictArgs(null, [])).toBeNull();
    expect(parseCodexMcpList('not json')).toBeNull();
    expect(parseCodexMcpList('[{"x":1}]')).toBeNull();
    // `-c` cannot address a dotted name (checked on codex-cli 0.164).
    expect(codexStrictArgs(['my.server'], [])).toBeNull();
    expect(codexStrictArgs(['my.server'], ['my.server'])).toContain('web_search');
  });

  it('a strict surface whose servers cannot be read never starts Codex', async () => {
    const lines: string[] = [];
    const code = await runT3Headless({ cwd: tmpdir(), prompt: 'x', surface: 'light' }, { write: (l) => lines.push(l), env: {}, home: mkdtempSync(join(tmpdir(), 'dc-lean-')), brain: null, envGate: true, listMcp: () => null });
    expect(code).toBe(1);
    expect(lines.join('')).toContain('could not be switched off');
  });

  it('runs unattended only with the .env gate live and the project trusted', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-lean-'));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lean-')));
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(cwd, '.codex'));
    expect(codexEnvGateReady(cwd, home)).toBe(false);
    writeFileSync(join(cwd, '.codex', 'hooks.json'), '{"hooks":{"PreToolUse":[{"command":"dreamcontext hook pre-tool-use --format codex"}]}}');
    expect(codexEnvGateReady(cwd, home)).toBe(false);
    writeFileSync(join(home, '.codex', 'config.toml'), `[projects."${cwd}"]\ntrust_level = "untrusted"\n`);
    expect(codexEnvGateReady(cwd, home)).toBe(false);
    const folder = `[projects."${cwd}"]\ntrust_level = "trusted"\n`;
    // The folder alone is not enough: Codex asks about the hooks separately.
    writeFileSync(join(home, '.codex', 'config.toml'), folder);
    expect(codexEnvGateReady(cwd, home)).toBe(false);
    const hook = `[hooks.state."${join(cwd, '.codex', 'hooks.json')}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`;
    writeFileSync(join(home, '.codex', 'config.toml'), `${folder}\n${hook}`);
    expect(codexEnvGateReady(cwd, home)).toBe(true);
    writeFileSync(join(home, '.codex', 'config.toml'), `${folder}\n${hook}enabled = false\n`);
    expect(codexEnvGateReady(cwd, home)).toBe(false);
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('the Codex terminal', () => {
  it('stays sandboxed whatever the chat was, and resumes its thread', () => {
    const line = codexExecLine({ model: 'gpt-5.6-terra', effort: 'high', resume: '019a0000-0000-7000-8000-000000000001', signedInFile: false, promptArg: '' });
    expect(line).toBe(`exec codex -m gpt-5.6-terra -c 'model_reasoning_effort="high"' -s workspace-write -a on-request resume 019a0000-0000-7000-8000-000000000001`);
    expect(line).not.toContain('dangerously');
  });

  it('runs on the account home, and #0 stays as it is', () => {
    const home = '/h';
    expect(codexTerminalEnv('', home)).toEqual({ env: {}, pre: [] });
    expect(codexTerminalEnv('primary', home)).toEqual({ env: {}, pre: [] });
    expect(codexTerminalEnv('../x', home)).toEqual({ env: {}, pre: [] });
    const acct = codexTerminalEnv('acct1', home);
    expect(acct.env.CODEX_HOME).toContain('codex-accounts/acct1');
    expect(acct.pre).toContain('cli_auth_credentials_store="file"');
  });
});
