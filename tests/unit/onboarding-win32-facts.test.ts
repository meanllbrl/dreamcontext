import { describe, it, expect } from 'vitest';
import { win32ShellFacts, parseShellFacts } from '../../src/lib/onboarding/runner.js';

const ENV = {
  PATH: 'C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Program Files\\GitHub CLI;C:\\Program Files\\Git\\cmd',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
} as NodeJS.ProcessEnv;

const ok = async () => ({ ok: true, stdout: 'v24.13.1\n', stderr: '', code: 0 });

describe('win32ShellFacts — the login-shell answers, read from PATH', () => {
  it('finds every tool on PATH and prefers the real claude.exe over the npm shim', async () => {
    const files = new Set([
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files\\nodejs\\npm.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\dreamcontext.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
    ]);
    const r = await win32ShellFacts(ENV, (p) => files.has(p), ok);
    expect(parseShellFacts(r.stdout, '')).toEqual({
      shell: '',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      nodeVersion: 'v24.13.1',
      npm: 'C:\\Program Files\\nodejs\\npm.cmd',
      dreamcontext: 'C:\\Users\\me\\AppData\\Roaming\\npm\\dreamcontext.cmd',
      claude: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      gh: 'C:\\Program Files\\GitHub CLI\\gh.exe',
      cltInstalled: false,
      git: 'C:\\Program Files\\Git\\cmd\\git.exe',
    });
  });

  it('reports nothing it cannot find, and no git whose --version fails', async () => {
    const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe']);
    const fail = async () => ({ ok: false, stdout: '', stderr: 'x', code: 1 });
    const r = await win32ShellFacts(ENV, (p) => files.has(p), fail);
    expect(parseShellFacts(r.stdout, '')).toEqual({ shell: '', cltInstalled: false });
  });
});
