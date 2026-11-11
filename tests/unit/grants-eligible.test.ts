/**
 * What size of grant a call may take (plan uye-bildirim K3, criterion 3): an always-rule exists
 * only as a pinned script run by a listed interpreter; every other shell command is Allow once,
 * with a reason a card can show. Pure: a stand-in resolver plays the disk.
 */
import { describe, it, expect } from 'vitest';
import { INTERPRETERS, eligible, scriptForm, type EligibleCtx, type Resolver } from '../../src/lib/grants/eligible.js';
import { canonicalInput, inputRecord } from '../../src/lib/grants/canonical.js';

const PROJECT = '/work/acme';
const LINKED = '/work/linked';
const TMP = '/private/tmp/acme-job';
const HOME = '/Users/owner';

interface Disk { bins: Record<string, string>; links: Record<string, string>; files: Record<string, string>; dirs: Set<string> }

function disk(): Disk {
  return {
    bins: {
      node: '/usr/local/bin/node', python3: '/usr/bin/python3', bash: '/bin/bash', sh: '/bin/sh', tsx: '/usr/local/bin/tsx',
      npm: '/usr/local/bin/npm', ruby: '/usr/bin/ruby', git: '/usr/bin/git', make: '/usr/bin/make', pytest: '/usr/local/bin/pytest', ls: '/bin/ls',
    },
    links: { '/usr/local/bin/node': '/usr/local/Cellar/node/22/bin/node' },
    files: {
      '/usr/local/Cellar/node/22/bin/node': 'sha-node', '/usr/bin/python3': 'sha-py', '/bin/bash': 'sha-bash', '/bin/sh': 'sha-sh',
      '/usr/local/bin/tsx': 'sha-tsx', '/usr/local/bin/npm': 'sha-npm', '/usr/bin/ruby': 'sha-ruby', '/usr/bin/git': 'sha-git',
      '/usr/bin/make': 'sha-make', '/usr/local/bin/pytest': 'sha-pytest', '/bin/ls': 'sha-ls',
      [`${PROJECT}/scripts/build.mjs`]: 'sha-build', [`${PROJECT}/scripts/other.mjs`]: 'sha-other', [`${PROJECT}/tools/x.py`]: 'sha-x',
      [`${LINKED}/run.sh`]: 'sha-linked', [`${TMP}/probe.mjs`]: 'sha-tmp', '/outside/s.mjs': 'sha-out',
    },
    dirs: new Set([PROJECT, LINKED, TMP, `${PROJECT}/scripts`]),
  };
}

function resolver(d: Disk): Resolver {
  return {
    which: (n) => d.bins[n] ?? null,
    realpath: (p) => {
      let q = p;
      for (let i = 0; i < 8 && d.links[q]; i += 1) q = d.links[q];
      return d.files[q] !== undefined || d.dirs.has(q) ? q : null;
    },
    isRegularFile: (p) => d.files[p] !== undefined,
    sha256: (p) => d.files[p] ?? null,
  };
}

const ctx = (d = disk(), over: Partial<EligibleCtx> = {}): EligibleCtx => ({ project: PROJECT, roots: [PROJECT, LINKED, TMP], home: HOME, resolve: resolver(d), ...over });
const bash = (command: string) => ({ command, description: 'what the agent says it does' });

describe('grants eligible: the script form is the only always-rule for a shell', () => {
  it('takes a pinned script with any arguments, for this job and for the member', () => {
    for (const scope of ['job', 'member'] as const) {
      const r = eligible('Bash', bash('node scripts/build.mjs --fast out/dir'), scope, ctx());
      expect(r).toEqual({
        ok: true, form: 'script',
        script: { interpreter: 'node', interpreterPath: '/usr/local/Cellar/node/22/bin/node', scriptPath: `${PROJECT}/scripts/build.mjs`, sha256: 'sha-build' },
      });
    }
  });

  it('takes a script in a linked repo or a temp folder, by every listed interpreter', () => {
    expect(eligible('Bash', bash(`bash ${LINKED}/run.sh`), 'member', ctx())).toMatchObject({ ok: true, form: 'script' });
    expect(eligible('Bash', bash(`node ${TMP}/probe.mjs`), 'job', ctx())).toMatchObject({ ok: true, form: 'script' });
    expect(eligible('Bash', bash('python3 tools/x.py a=1'), 'job', ctx())).toMatchObject({ ok: true, form: 'script' });
    expect([...INTERPRETERS]).toEqual(['node', 'python3', 'bash', 'sh', 'tsx']);
  });

  it('a once on the script form still pins the script (a rewrite after his tap asks again)', () => {
    expect(eligible('Bash', bash('node scripts/build.mjs'), 'once', ctx())).toMatchObject({ ok: true, form: 'script', script: { sha256: 'sha-build' } });
  });

  const onceOnly: Array<[string, string, RegExp]> = [
    ['module runner', 'python3 -m pkg', /option comes before the script/],
    ['--require before the script', 'node --require x scripts/build.mjs', /option comes before the script/],
    ['-c', 'python3 -c print', /option comes before the script/],
    ['-e', 'node -e 1', /option comes before the script/],
    ['env wrapper', 'env node scripts/build.mjs', /in front of the interpreter/],
    ['timeout wrapper', 'timeout 5 node scripts/build.mjs', /in front of the interpreter/],
    ['environment assignment', 'FOO=1 node scripts/build.mjs', /environment setting/],
    ['interpreter off the list', 'ruby x.rb', /Only a script run by node/],
    ['interpreter given as a path', './node scripts/build.mjs', /given as a path/],
    ['npm test', 'npm test', /Only a script run by node/],
    ['pytest', 'pytest', /Only a script run by node/],
    ['make', 'make x', /Only a script run by node/],
    ['git', 'git commit -m x', /Only a script run by node/],
    ['bare program', 'ls', /Only a script run by node/],
    ['pipeline', 'node scripts/build.mjs | cat', /shell syntax/],
    ['substitution', 'node scripts/build.mjs $(whoami)', /shell syntax/],
    ['redirect', 'node scripts/build.mjs > out.txt', /shell syntax/],
    ['quotes', 'node scripts/build.mjs "a b"', /shell syntax/],
    ['newline', 'node scripts/build.mjs\nrm -rf out', /more than one line/],
    ['control character', 'node scripts/build.mjs \u0007x', /hidden or control/],
    ['bidi character', 'node scripts/build.mjs ‮x', /hidden or control/],
    ['a secret', 'node scripts/build.mjs sk-ant-abcdefghijklmnopqrstuvwxyz012345', /secret/],
    ['script outside the roots', 'node /outside/s.mjs', /outside the project/],
    ['no such script', 'node scripts/missing.mjs', /not a regular file/],
    ['no script at all', 'node', /No script follows/],
    ['outward', 'git push origin main', /sends something off this Mac/],
  ];
  it.each(onceOnly)('%s: once only, with its reason', (_name, command, reason) => {
    for (const scope of ['job', 'member'] as const) {
      const r = eligible('Bash', bash(command), scope, ctx());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
    expect(eligible('Bash', bash(command), 'once', ctx()).ok).toBe(true);
  });

  it('a listed name that resolves inside the project (a planted node) is once only', () => {
    const d = disk();
    d.bins.node = `${PROJECT}/node_modules/.bin/node`;
    d.files[`${PROJECT}/node_modules/.bin/node`] = 'sha-planted';
    const r = eligible('Bash', bash('node scripts/build.mjs'), 'job', ctx(d));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/inside a folder agents can write to/) });
    // A PATH entry outside the project that links into it is the same plant.
    const e = disk();
    e.links['/usr/local/bin/node'] = `${TMP}/node`;
    e.files[`${TMP}/node`] = 'sha-planted';
    expect(eligible('Bash', bash('node scripts/build.mjs'), 'member', ctx(e)).ok).toBe(false);
  });

  it('an interpreter not found on this Mac is once only', () => {
    const d = disk();
    delete d.bins.tsx;
    expect(eligible('Bash', bash('tsx scripts/build.mjs'), 'job', ctx(d))).toEqual({ ok: false, reason: expect.stringMatching(/not found/) });
  });

  it.each(['production_deploy', 'credential_materialization', 'secret_store_writes', 'a_category_nobody_named'])(
    'classifier category %s: never an always-rule, Allow once stays',
    (category) => {
      const c = ctx(disk(), { category });
      expect(eligible('Bash', bash('node scripts/build.mjs'), 'job', c).ok).toBe(false);
      expect(eligible('Bash', bash('node scripts/build.mjs'), 'member', c).ok).toBe(false);
      expect(eligible('Bash', bash('node scripts/build.mjs'), 'once', c).ok).toBe(true);
    },
  );

  it('no category given means none (a rule refusal, the bridge)', () => {
    expect(eligible('Bash', bash('node scripts/build.mjs'), 'job', ctx(disk(), { category: '' })).ok).toBe(true);
  });

  it('scriptForm tells the card why before anyone taps', () => {
    expect(scriptForm('npm test', ctx())).toEqual({ reason: expect.stringMatching(/allowed once/) });
    expect('pin' in scriptForm('sh scripts/build.mjs', ctx())).toBe(true);
  });
});

describe('grants eligible: other tools take the exact input, once and for this job only', () => {
  const write = { file_path: `${PROJECT}/notes/a.md`, content: 'x' };

  it('a file tool: once and job, never a member rule', () => {
    expect(eligible('Write', write, 'once', ctx())).toEqual({ ok: true, form: 'exact' });
    expect(eligible('Write', write, 'job', ctx())).toEqual({ ok: true, form: 'exact' });
    expect(eligible('Write', write, 'member', ctx()).ok).toBe(false);
  });

  it('an MCP tool: job yes, member no; one that sends is once only', () => {
    expect(eligible('mcp__notes__lookup_page', { q: 'x' }, 'job', ctx())).toEqual({ ok: true, form: 'exact' });
    expect(eligible('mcp__notes__lookup_page', { q: 'x' }, 'member', ctx()).ok).toBe(false);
    const send = eligible('mcp__chat__send_message', { to: 'x', text: 'hi' }, 'job', ctx());
    expect(send).toEqual({ ok: false, reason: expect.stringMatching(/sends something off this Mac/) });
    expect(eligible('mcp__chat__send_message', { to: 'x', text: 'hi' }, 'once', ctx()).ok).toBe(true);
  });

  it('what the bypass gate brings to the owner (a marketing secret file) is once only', () => {
    const r = eligible('Write', { file_path: `${PROJECT}/marketing/.env`, content: 'K=v' }, 'job', ctx());
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/protected file/) });
  });

  it('the grant and approval stores themselves are never covered by a rule', () => {
    expect(eligible('Write', { file_path: `${HOME}/.dreamcontext/grants/rules/x.json`, content: '{}' }, 'job', ctx()).ok).toBe(false);
    expect(eligible('Edit', { file_path: `${HOME}/.dreamcontext/automations.json`, old_string: 'a', new_string: 'b' }, 'job', ctx()).ok).toBe(false);
  });

  it('a Codex shell (argv, no single spelling) is once only', () => {
    expect(eligible('shell', { command: ['node', 'scripts/build.mjs'] }, 'job', ctx()).ok).toBe(false);
    expect(eligible('shell', { command: ['node', 'scripts/build.mjs'] }, 'once', ctx()).ok).toBe(true);
  });
});

describe('grants canonical input', () => {
  it('Bash is the command trimmed and nothing else', () => {
    expect(canonicalInput('Bash', { command: '  node a.mjs  ', description: 'x', timeout: 5 })).toBe('node a.mjs');
    expect(canonicalInput('Bash', ' node a.mjs ')).toBe('node a.mjs');
    // Inner spacing is the command's own: never normalised, so two commands never share a grant.
    expect(canonicalInput('Bash', { command: 'node  a.mjs' })).not.toBe(canonicalInput('Bash', { command: 'node a.mjs' }));
  });

  it('other tools are stable-key JSON, and a stored canonical string reads back the same', () => {
    const a = canonicalInput('Write', { file_path: '/p/a', content: 'x', extra: { b: 1, a: 2 } });
    const b = canonicalInput('Write', { extra: { a: 2, b: 1 }, content: 'x', file_path: '/p/a' });
    expect(a).toBe(b);
    expect(a).toBe('{"content":"x","extra":{"a":2,"b":1},"file_path":"/p/a"}');
    expect(canonicalInput('Write', a)).toBe(a);
    expect(inputRecord('Write', a)).toEqual({ content: 'x', extra: { a: 2, b: 1 }, file_path: '/p/a' });
    expect(inputRecord('Bash', 'ls')).toEqual({ command: 'ls' });
  });
});
