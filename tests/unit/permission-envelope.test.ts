/** Every headless surface, one row each: a Codex run is never wider than its Claude rule. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEADLESS_ENVELOPES, codexModelOf, codexRunArgs, type HeadlessSurface } from '../../src/lib/t3-bridge/headless-envelope.js';
import { codexRuntimePolicy } from '../../src/lib/t3-bridge/policy.js';

const CWD = '/tmp/project';
const SURFACES = Object.keys(HEADLESS_ENVELOPES) as HeadlessSurface[];

describe('headless envelopes', () => {
  it('names every surface the plan lists', () => {
    expect(SURFACES.sort()).toEqual(['agent', 'approval-question', 'automation', 'board-agent', 'builder', 'light', 'peer', 'sleep', 'super-child', 'task-step', 'verdict']);
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
