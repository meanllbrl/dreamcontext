/** Every headless surface, one row each: a Codex run is never wider than its Claude rule. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADLESS_ENVELOPES, codexModelOf, codexRunArgs, envelopeMode, envelopeRefusal, isPlainReadCommand, toolRunArgs, type HeadlessSurface } from '../../src/lib/t3-bridge/headless-envelope.js';
import { codexRuntimePolicy } from '../../src/lib/t3-bridge/policy.js';

const CWD = '/tmp/project';
const SURFACES = Object.keys(HEADLESS_ENVELOPES) as HeadlessSurface[];

describe('headless envelopes', () => {
  it('names every surface the plan lists', () => {
    expect(SURFACES.sort()).toEqual(['agent', 'approval-question', 'ask', 'ask-write', 'automation', 'board-agent', 'builder', 'light', 'peer', 'sleep', 'super-child', 'task-step', 'verdict']);
  });

  it.each(SURFACES)('%s never reaches full access', (surface) => {
    const row = HEADLESS_ENVELOPES[surface];
    if (row.codex === null) { expect(row.why).toBeTruthy(); return; }
    const p = codexRuntimePolicy({ mode: row.codex, cwd: CWD, extraRoots: [join(homedir(), '.dreamcontext', 'x'), '/tmp/linked'], privateTmp: '/tmp/own' });
    expect(p.runtimeMode).not.toBe('full-access');
    expect(p.runtimeMode).not.toBe('auto');
    if (row.codex === 'auto') {
      const sandbox = p.sandboxPolicy as { networkAccess: boolean; writableRoots: string[]; excludeSlashTmp: boolean; excludeTmpdirEnvVar: boolean };
      expect(sandbox.networkAccess).toBe(false);
      expect(sandbox.excludeSlashTmp).toBe(true);
      expect(sandbox.excludeTmpdirEnvVar).toBe(true);
      expect(sandbox.writableRoots).toEqual([CWD, '/tmp/linked', '/tmp/own']);
    } else {
      expect(p.sandboxPolicy).toBeUndefined();
      expect(p.runtimeMode).toBe('approval-required');
    }
  });

  it.each(SURFACES)('%s on Antigravity: a flavour, or a named limit', (surface) => {
    const row = HEADLESS_ENVELOPES[surface];
    if (row.antigravity === null) { expect(row.antigravityWhy).toBeTruthy(); expect(envelopeRefusal(surface, 'antigravity')).toBe(row.antigravityWhy); return; }
    expect(['write', 'read']).toContain(row.antigravity);
    // No sandbox there: a surface writes on Antigravity only where Codex writes in its sandbox,
    // and a read-only surface stays read-only.
    if (row.antigravity === 'write') expect(row.codex).toBe('auto');
    if (row.codex === 'default') expect(row.antigravity).toBe('read');
    expect(envelopeRefusal(surface, 'antigravity')).toBe('');
  });

  it('the read-only surfaces are read-only on both tools and carry no brain write path', () => {
    for (const s of ['light', 'ask', 'approval-question'] as const) {
      expect(envelopeMode(s, 'codex')).toBe('default');
      expect(envelopeMode(s, 'antigravity')).toBe('read');
      expect(HEADLESS_ENVELOPES[s].brain).toBe(false);
    }
  });

  it('a read-only run starts one plain reading program, nothing else', () => {
    for (const ok of ['cat README.md', 'ls -la src', 'grep -rn foo src', 'git log --oneline -5', 'git diff HEAD~1', 'dreamcontext memory recall "lid colour"', 'dreamcontext tasks list', 'find . -name "*.ts"', 'pwd', `/bin/zsh -lc "sed -n '1,240p' /p/SKILL.md"`, '/bin/zsh -lc \'dreamcontext memory recall "lid"\'', 'bash -c "ls -la"', "sed -n '5p' a.md"]) expect(isPlainReadCommand(ok), ok).toBe(true);
    for (const no of ['rm -rf x', 'cat a > b', 'cat a | sh', 'ls; rm x', 'echo $(rm x)', 'echo `id`', 'find . -delete', 'find . -exec rm {} ;', 'git commit -m x', 'git branch evil', 'git diff --output=x', 'dreamcontext tasks create x', 'dreamcontext tasks log x y', 'npm test', 'node -e 1', 'python3 x.py', 'sed -i s/a/b/ f', 'cat a && rm b', 'touch x', '', 'tee x', 'cat a\nrm b', '/bin/zsh -lc "rm -rf x"', '/bin/zsh -lc "cat $HOME/x"', '/bin/zsh -lc "ls; rm x"', "sed -n 'w out' a", "sed -i '1d' a", "sed -n '1p' -i a", 'zsh -lc "echo a" extra']) expect(isPlainReadCommand(no), no).toBe(false);
  });

  it('the run command names Antigravity only when asked, before the extra roots', () => {
    expect(toolRunArgs({ tool: 'antigravity', surface: 'sleep', prompt: 'p', extraRoots: ['/r'] })).toEqual(['t3-run', '--surface', 'sleep', '--prompt=p', '--tool', 'antigravity', '--extra-root', '/r']);
    expect(toolRunArgs({ tool: 'codex', surface: 'sleep', prompt: 'p' })).toEqual(['t3-run', '--surface', 'sleep', '--prompt=p']);
  });

  it('a board agent stays on Claude: Codex proved no read-denies', () => {
    expect(HEADLESS_ENVELOPES['board-agent'].codex).toBeNull();
  });

  it('a light job is read-only and has no brain write path', () => {
    expect(HEADLESS_ENVELOPES.light).toMatchObject({ codex: 'default', brain: false });
  });

  it('a prompt starting with a dash stays the prompt, extra roots come last', () => {
    const a = codexRunArgs({ surface: 'automation', prompt: '--mode bypass', model: 'gpt-5.6-terra', account: 'acct1', extraRoots: ['/r'] });
    expect(a).toEqual(['t3-run', '--surface', 'automation', '--prompt=--mode bypass', '--model', 'gpt-5.6-terra', '--account', 'acct1', '--extra-root', '/r']);
  });

  it('a Claude model name is not sent to Codex', () => {
    expect(codexModelOf('opus')).toBeNull();
    expect(codexModelOf('claude-opus-5-5')).toBeNull();
    expect(codexModelOf('gpt-6-luna')).toBe('gpt-6-luna');
  });
});
