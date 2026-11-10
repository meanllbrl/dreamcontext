/**
 * Does a live grant cover a call (plan uye-bildirim K3 gate G1, criterion 3): eligibility is re-run
 * for the grant's own scope and every pin is re-resolved at match time, so a script edited after
 * the rule, a swapped link, an interpreter that now resolves elsewhere or a hand-written rule of
 * another form never matches. Pure: a stand-in resolver plays the disk and can change under it.
 */
import { describe, it, expect } from 'vitest';
import { match, type MatchCall, type MatchCtx } from '../../src/lib/grants/match.js';
import type { Resolver } from '../../src/lib/grants/eligible.js';
import { GRANT_MAX_MS, MEMBER_NO_EXPIRY, type Grant } from '../../src/lib/grants/types.js';

const PROJECT = '/work/acme';
const NODE = '/usr/local/Cellar/node/22/bin/node';
const BUILD = `${PROJECT}/scripts/build.mjs`;
const NOW = 1_800_000_000_000;

function world() {
  const d = {
    bins: { node: '/usr/local/bin/node', npm: '/usr/local/bin/npm' } as Record<string, string>,
    links: { '/usr/local/bin/node': NODE, [`${PROJECT}/run.mjs`]: BUILD } as Record<string, string>,
    files: { [NODE]: 'sha-node', '/usr/local/bin/npm': 'sha-npm', [BUILD]: 'sha-build', [`${PROJECT}/scripts/other.mjs`]: 'sha-other' } as Record<string, string>,
    dirs: new Set([PROJECT, `${PROJECT}/scripts`]),
  };
  const resolve: Resolver = {
    which: (n) => d.bins[n] ?? null,
    realpath: (p) => {
      let q = p;
      for (let i = 0; i < 8 && d.links[q]; i += 1) q = d.links[q];
      return d.files[q] !== undefined || d.dirs.has(q) ? q : null;
    },
    isRegularFile: (p) => d.files[p] !== undefined,
    sha256: (p) => d.files[p] ?? null,
  };
  const ctx: MatchCtx = { project: PROJECT, roots: [PROJECT], home: '/Users/owner', resolve, now: NOW };
  return { d, ctx };
}

const PIN_SCRIPT = { interpreter: 'node', interpreterPath: NODE, scriptPath: BUILD, sha256: 'sha-build' };
const grant = (over: Partial<Grant> = {}): Grant => ({
  id: 'job-a', scope: 'job', project: PROJECT, pin: 'pin-member-super', tool: 'Bash', input: 'node scripts/build.mjs',
  form: 'script', script: PIN_SCRIPT, createdAt: NOW - 60_000, expiresAt: NOW + GRANT_MAX_MS, ...over,
});
const call = (over: Partial<MatchCall> = {}): MatchCall => ({
  project: PROJECT, pin: 'pin-member-super', member: 'scout', tool: 'Bash', input: { command: 'node scripts/build.mjs' }, ...over,
});

describe('grants match: a pinned script rule', () => {
  it('covers the pinned script with any arguments, in its own session', () => {
    const { ctx } = world();
    const g = grant();
    expect(match([g], call(), ctx)).toBe(g);
    expect(match([g], call({ input: { command: 'node scripts/build.mjs --fast out' } }), ctx)).toBe(g);
    // Reached through a link to the same file: the real path is what is pinned.
    expect(match([g], call({ input: { command: 'node run.mjs' } }), ctx)).toBe(g);
  });

  it('a script edited after the rule: no match', () => {
    const { d, ctx } = world();
    d.files[BUILD] = 'sha-edited';
    expect(match([grant()], call(), ctx)).toBeNull();
  });

  it('a swapped symlink: no match', () => {
    const { d, ctx } = world();
    d.links[`${PROJECT}/run.mjs`] = `${PROJECT}/scripts/other.mjs`;
    expect(match([grant()], call({ input: { command: 'node run.mjs' } }), ctx)).toBeNull();
  });

  it('a second script: no match', () => {
    const { ctx } = world();
    expect(match([grant()], call({ input: { command: 'node scripts/other.mjs' } }), ctx)).toBeNull();
  });

  it('an interpreter that later resolves elsewhere: no match', () => {
    const { d, ctx } = world();
    d.bins.node = '/opt/homebrew/bin/node';
    d.files['/opt/homebrew/bin/node'] = 'sha-node-2';
    expect(match([grant()], call(), ctx)).toBeNull();
  });

  it('an interpreter later planted in the project: no match', () => {
    const { d, ctx } = world();
    d.bins.node = `${PROJECT}/node`;
    d.files[`${PROJECT}/node`] = 'sha-planted';
    expect(match([grant()], call(), ctx)).toBeNull();
  });

  it('a wrapper in front of the pinned script: no match', () => {
    const { ctx } = world();
    expect(match([grant()], call({ input: { command: 'env node scripts/build.mjs' } }), ctx)).toBeNull();
    expect(match([grant()], call({ input: { command: 'node scripts/build.mjs; rm -rf x' } }), ctx)).toBeNull();
  });

  it('a pinned interpreter hash, when given, is checked too', () => {
    const { d, ctx } = world();
    const g = grant({ script: { ...PIN_SCRIPT, interpreterSha: 'sha-node' } });
    expect(match([g], call(), ctx)).toBe(g);
    d.files[NODE] = 'sha-node-replaced';
    expect(match([g], call(), ctx)).toBeNull();
  });
});

describe('grants match: a hand-written rule of any other form never matches', () => {
  it('an exact rule for a runner, a member rule for a file tool, a script rule over a runner', () => {
    const { ctx } = world();
    expect(match([grant({ form: 'exact', script: undefined, input: 'npm test' })], call({ input: { command: 'npm test' } }), ctx)).toBeNull();
    expect(match([grant({ scope: 'member', pin: undefined, member: 'scout', tool: 'Write', form: 'exact', script: undefined, input: '{"content":"x","file_path":"/work/acme/a.md"}', expiresAt: MEMBER_NO_EXPIRY })],
      call({ tool: 'Write', input: { file_path: '/work/acme/a.md', content: 'x' } }), ctx)).toBeNull();
    expect(match([grant({ input: 'npm test', script: { ...PIN_SCRIPT, interpreter: 'npm', interpreterPath: '/usr/local/bin/npm', sha256: 'sha-npm' } })],
      call({ input: { command: 'npm test' } }), ctx)).toBeNull();
    // An exact rule over a call that IS the script form: the form must agree.
    expect(match([grant({ form: 'exact', script: undefined })], call(), ctx)).toBeNull();
  });
});

describe('grants match: scopes and their deaths', () => {
  it('a job grant matches its own session only, and a respawn under the same pin keeps it', () => {
    const { ctx } = world();
    const g = grant();
    expect(match([g], call({ pin: 'pin-sibling-child' }), ctx)).toBeNull();
    expect(match([g], call({ pin: 'pin-member-other-session' }), ctx)).toBeNull();
    // A respawned process of the same session carries the same pin.
    expect(match([g], call({ pin: 'pin-member-super' }), ctx)).toBe(g);
  });

  it('a job or once grant is dead after a day, whatever its stored expiry says', () => {
    const { ctx } = world();
    const old = grant({ createdAt: NOW - GRANT_MAX_MS - 1, expiresAt: NOW + 10 * GRANT_MAX_MS });
    expect(match([old], call(), ctx)).toBeNull();
    expect(match([grant({ expiresAt: NOW - 1 })], call(), ctx)).toBeNull();
  });

  it('a member rule matches the member\'s session and its children, never another member or main\'s crew', () => {
    const { ctx } = world();
    const g = grant({ id: 'member-a', scope: 'member', pin: undefined, member: 'scout', expiresAt: MEMBER_NO_EXPIRY, createdAt: NOW - 30 * GRANT_MAX_MS });
    expect(match([g], call({ pin: 'pin-member-super' }), ctx)).toBe(g);
    expect(match([g], call({ pin: 'pin-member-child' }), ctx)).toBe(g);
    expect(match([g], call({ member: 'writer' }), ctx)).toBeNull();
    expect(match([g], call({ member: undefined }), ctx)).toBeNull();
  });

  it('a one-shot is that exact call only, and its script pin holds too', () => {
    const { d, ctx } = world();
    const once = grant({ id: 'once-a', scope: 'once' });
    expect(match([once], call(), ctx)).toBe(once);
    expect(match([once], call({ input: { command: 'node scripts/build.mjs --other' } }), ctx)).toBeNull();
    d.files[BUILD] = 'sha-edited';
    expect(match([once], call(), ctx)).toBeNull();
    const exact = grant({ id: 'once-b', scope: 'once', form: 'exact', script: undefined, input: 'npm test' });
    expect(match([exact], call({ input: { command: 'npm test' } }), ctx)).toBe(exact);
    expect(match([exact], call({ input: { command: 'npm test -- --watch' } }), ctx)).toBeNull();
  });

  it('a rule is preferred to a one-shot, so the one-shot is not spent', () => {
    const { ctx } = world();
    const once = grant({ id: 'once-a', scope: 'once' });
    const job = grant();
    expect(match([once, job], call(), ctx)).toBe(job);
  });

  it('another project or another tool: no match', () => {
    const { ctx } = world();
    expect(match([grant({ project: '/work/other' })], call(), ctx)).toBeNull();
    expect(match([grant()], call({ project: '/work/other' }), ctx)).toBeNull();
    expect(match([grant()], call({ tool: 'Write' }), ctx)).toBeNull();
  });

  it('a script that left the agent roots no longer matches', () => {
    const { ctx } = world();
    expect(match([grant()], call(), { ...ctx, roots: ['/work/elsewhere'] })).toBeNull();
  });
});
