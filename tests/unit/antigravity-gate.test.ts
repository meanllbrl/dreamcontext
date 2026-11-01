/**
 * The Antigravity gate: fake HOME only. What the agent does with the file is measured live (see the
 * module header); here, what we write, how a call is read, and that the hook is closed by default.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { ANTIGRAVITY_GATE_NAME, antigravityCallAsClaude, antigravityGateCommand, antigravityGateGap, antigravityHooksFile, isAntigravityGateFile, syncAntigravityGate } from '../../src/lib/antigravity-gate.js';
import { shellWriteTarget } from '../../src/lib/agents/member-file-guard.js';

const NODE = '/opt/fake/node';
const CLI = '/opt/fake app/dist/index.js';

describe('the hook file in an account profile', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-gate-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  const read = (): Record<string, any> => JSON.parse(readFileSync(antigravityHooksFile('primary', home), 'utf-8'));

  it('names the gate for every tool, with paths the agent splits with shlex and no shell', () => {
    expect(syncAntigravityGate('primary', { node: NODE, cli: CLI, home })).toEqual({ ok: true });
    const hook = read()[ANTIGRAVITY_GATE_NAME].PreToolUse[0];
    expect(hook.matcher).toBe('*');
    expect(hook.hooks[0].command).toBe(`'/opt/fake/node' '/opt/fake app/dist/index.js' 'hook' 'pre-tool-use' '--format' 'antigravity'`);
    expect(antigravityGateCommand("/a'b/node", '/c')).toContain(`'/a'"'"'b/node'`);
  });

  it('is one file per account and never the owner\'s .gemini', () => {
    syncAntigravityGate('work', { node: NODE, cli: CLI, home });
    expect(existsSync(join(antigravityProfileDir('work', home), 'config', 'hooks.json'))).toBe(true);
    expect(existsSync(join(antigravityProfileDir('primary', home), 'config', 'hooks.json'))).toBe(false);
    expect(existsSync(join(home, '.gemini'))).toBe(false);
  });

  it('keeps another named hook, repairs ours, and survives a broken file', () => {
    const file = antigravityHooksFile('primary', home);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ owners: { Stop: [] }, [ANTIGRAVITY_GATE_NAME]: { enabled: false } }));
    syncAntigravityGate('primary', { node: NODE, cli: CLI, home });
    expect(read().owners).toEqual({ Stop: [] });
    expect(read()[ANTIGRAVITY_GATE_NAME].enabled).toBeUndefined();
    writeFileSync(file, '{ not json');
    syncAntigravityGate('primary', { node: NODE, cli: CLI, home });
    expect(read()[ANTIGRAVITY_GATE_NAME].PreToolUse).toBeTruthy();
  });

  it('replaces a planted link instead of writing through it', () => {
    const file = antigravityHooksFile('primary', home);
    mkdirSync(join(file, '..'), { recursive: true });
    const outside = join(home, 'outside.json');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, file);
    expect(syncAntigravityGate('primary', { node: NODE, cli: CLI, home }).ok).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe('untouched');
    expect(lstatSync(file).isFile()).toBe(true);
  });

  it('a config folder that is a link is refused, not followed', () => {
    const profile = antigravityProfileDir('primary', home);
    mkdirSync(profile, { recursive: true });
    const real = join(home, 'real-config');
    mkdirSync(real);
    symlinkSync(real, join(profile, 'config'));
    expect(syncAntigravityGate('primary', { node: NODE, cli: CLI, home }).ok).toBe(false);
    expect(existsSync(join(real, 'hooks.json'))).toBe(false);
  });

  it('says what is missing for a child, and holds when the hook does not refuse', () => {
    expect(antigravityGateGap(home, { node: '', cli: '', home })).toMatch(/could not put its gate/);
    expect(antigravityGateGap(home, { node: NODE, cli: CLI, home, hookAnswers: () => false })).toMatch(/did not refuse/);
    expect(antigravityGateGap(home, { node: NODE, cli: CLI, home, hookAnswers: () => true })).toBeNull();
  });
});

describe('a tool call as the gates read it (shapes measured on agent 1.4.1)', () => {
  const at = '/p';
  const call = (name: string, args: unknown, extra: object = {}) => antigravityCallAsClaude({ toolCall: { name, args }, workspacePaths: [at, '/skills'], ...extra });

  it('reads the shell and file tools', () => {
    expect(call('run_command', { CommandLine: 'ls', Cwd: '/q' })).toEqual({ toolName: 'Bash', toolInput: { command: 'ls' }, cwd: '/q' });
    expect(call('create_file', { TargetFile: '/p/a', CodeContent: 'x' })).toEqual({ toolName: 'Write', toolInput: { file_path: '/p/a' }, cwd: at });
    expect(call('edit_file', { TargetFile: '/p/a' })?.toolName).toBe('Edit');
    expect(call('send_command_input', { Input: 'rm x' })?.toolName).toBe('Bash');
  });

  it('a read stays a read; an unknown tool naming a path is judged as a write', () => {
    expect(call('view_file', { AbsolutePath: '/p/a' })?.toolName).toBe('view_file');
    expect(call('some_new_writer', { Path: '/p/a' })).toEqual({ toolName: 'Edit', toolInput: { file_path: '/p/a' }, cwd: at });
    expect(call('recall', { Arguments: {}, ToolName: 'recall' })?.toolName).toBe('recall');
  });

  it('a call it cannot read is null, which the hook refuses', () => {
    expect(antigravityCallAsClaude({})).toBeNull();
    expect(antigravityCallAsClaude({ toolCall: {} })).toBeNull();
  });

  it('knows the hook file of any account, and nothing else', () => {
    expect(isAntigravityGateFile(`/h/.dreamcontext/t3/state/providers/antigravity/${'a'.repeat(64)}/config/hooks.json`)).toBe(true);
    expect(isAntigravityGateFile('/p/.agents/hooks.json')).toBe(false);
  });
});

describe('a shell write to a guarded file', () => {
  const guarded = (abs: string): boolean => abs.endsWith('/marketing/.env');
  const at = (c: string, cwd = '/p/_dream_context') => shellWriteTarget(c, cwd, guarded, '/h');

  it('sees redirects, tee, cp, rm, sed -i and a cd', () => {
    expect(at('echo x >> marketing/.env')).toBe('/p/_dream_context/marketing/.env');
    expect(at('echo x | tee marketing/.env')).toBeTruthy();
    expect(at('cp /tmp/a marketing/.env')).toBeTruthy();
    expect(at('rm marketing/.env')).toBeTruthy();
    expect(at("sed -i '' s/a/b/ marketing/.env")).toBeTruthy();
    expect(at('cd marketing && echo x > .env')).toBeTruthy();
    expect(at(`python3 -c "open('marketing/.env','w').write('x')"`)).toBeTruthy();
    expect(at('printf x > "marketing/.env"')).toBeTruthy();
  });

  it('leaves reads and other files alone', () => {
    expect(at('cat marketing/.env')).toBeNull();
    expect(at('grep KEY marketing/.env | wc -l')).toBeNull();
    expect(at('cp marketing/.env /tmp/copy')).toBeNull();
    expect(at('echo marketing/.env > note.txt')).toBeNull();
  });
});

describe('the hook itself, built CLI', () => {
  const cli = resolve(import.meta.dirname, '../../dist/index.js');
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-agy-hook-')));
    mkdirSync(join(dir, '_dream_context', 'marketing'), { recursive: true });
    mkdirSync(join(dir, '_dream_context', 'agents'), { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = (body: string, env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [cli, 'hook', 'pre-tool-use', '--format', 'antigravity'], { cwd: dir, input: body, encoding: 'utf-8', env: { ...process.env, HOME: dir, ...env } });
  const tool = (name: string, args: object) => JSON.stringify({ toolCall: { name, args }, workspacePaths: [dir] });

  it.skipIf(!existsSync(cli))('denies in the agent\'s shape, allows with empty stdout, refuses what it cannot read', () => {
    const env = join(dir, '_dream_context', 'marketing', '.env');
    const member = join(dir, '_dream_context', 'agents', 'fox.md');
    const denied = (r: ReturnType<typeof run>) => (JSON.parse(r.stdout) as { decision: string }).decision === 'deny';
    expect(denied(run(tool('create_file', { TargetFile: env })))).toBe(true);
    expect(denied(run(tool('run_command', { CommandLine: 'echo x >> _dream_context/marketing/.env', Cwd: dir })))).toBe(true);
    expect(denied(run(tool('edit_file', { TargetFile: member })))).toBe(true);
    expect(denied(run(tool('run_command', { CommandLine: 'echo x >> _dream_context/agents/fox.md', Cwd: dir })))).toBe(true);
    expect(denied(run(tool('run_command', { CommandLine: `echo x > ${dir}/.dreamcontext/t3/state/providers/antigravity/${'b'.repeat(64)}/config/hooks.json`, Cwd: dir })))).toBe(true);
    expect(denied(run(tool('run_command', { CommandLine: 'npm run build', Cwd: dir })))).toBe(true);
    expect(denied(run('not json'))).toBe(true);
    expect(denied(run(''))).toBe(true);
    const read = run(tool('run_command', { CommandLine: 'cat _dream_context/marketing/.env', Cwd: dir }));
    expect([read.status, read.stdout]).toEqual([0, '']);
    expect(run(tool('view_file', { AbsolutePath: env })).stdout).toBe('');
  }, 60_000);

  it.skipIf(!existsSync(cli))('touches the beat each time it runs', () => {
    const beat = join(dir, 'beat');
    run(tool('view_file', { AbsolutePath: join(dir, 'a') }), { DREAMCONTEXT_GATE_BEAT: beat });
    expect(existsSync(beat)).toBe(true);
  }, 30_000);
});
