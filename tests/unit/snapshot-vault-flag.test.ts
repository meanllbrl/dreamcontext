import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';
import { writePeople } from '../../src/lib/people-store.js';

function makeProject(name: string): string {
  const root = join(
    tmpdir(),
    `dc-snap-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    '_dream_context',
  );
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function writeSoul(contextRoot: string, body: string): void {
  writeFileSync(join(contextRoot, 'core', '0.soul.md'), body);
}

/**
 * A people-first vault: an active person (resolved by the solo rung, so no
 * machine state is involved) plus one teammate, which is what makes the roster
 * section render at all.
 */
function writePeopleLayout(contextRoot: string, prefix: string): void {
  mkdirSync(join(contextRoot, 'people'), { recursive: true });
  writePeople(contextRoot, {
    [`${prefix}-ada`]: { name: `${prefix} Ada`, emails: [`ada@${prefix}.invalid`] },
    [`${prefix}-bob`]: { name: `${prefix} Bob`, emails: [`bob@${prefix}.invalid`], role: 'reviewer' },
  });
  writeFileSync(
    join(contextRoot, 'people', `${prefix}-ada.md`),
    `---\nname: ${prefix}-ada\ntype: person\n---\n\n## Preferences\n\n- ${prefix.toUpperCase()}_CONSTITUTION_MARKER\n`,
  );
  writeFileSync(
    join(contextRoot, 'people', `${prefix}-bob.md`),
    `---\nname: ${prefix}-bob\ntype: person\n---\n\n## Identity\n\n- Second person.\n`,
  );
}

describe('snapshot --vault rootOverride (federation P1.4 / P1.6)', () => {
  let originalCwd: string;
  let originalPerson: string | undefined;
  const roots: string[] = [];

  beforeEach(() => {
    originalCwd = process.cwd();
    originalPerson = process.env.DREAMCONTEXT_PERSON;
    delete process.env.DREAMCONTEXT_PERSON;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPerson === undefined) delete process.env.DREAMCONTEXT_PERSON;
    else process.env.DREAMCONTEXT_PERSON = originalPerson;
    for (const r of roots) rmSync(join(r, '..'), { recursive: true, force: true });
    roots.length = 0;
  });

  it('rootOverride prints the PEER vault\'s snapshot content (P1.4)', () => {
    const peer = makeProject('peer');
    roots.push(peer);
    writeSoul(peer, 'PEER_SOUL_MARKER — distinctive peer identity text');

    const out = generateSnapshot(peer);
    expect(out).toContain('PEER_SOUL_MARKER');
  });

  it('no-arg path resolves the local cwd context root — output is identical to passing that root (regression P1.6)', () => {
    const local = makeProject('local');
    roots.push(local);
    writeSoul(local, 'LOCAL_SOUL_MARKER — this is the local project');

    // chdir into the project so resolveContextRoot() finds `local`.
    process.chdir(join(local, '..'));

    const noArg = generateSnapshot();
    const explicit = generateSnapshot(local);

    expect(noArg).toContain('LOCAL_SOUL_MARKER');
    // BYTE-IDENTICAL: the no-arg default resolution must equal the explicit root.
    expect(noArg).toBe(explicit);
  });

  it('rootOverride does not bleed peer content into the local no-arg snapshot', () => {
    const local = makeProject('local2');
    const peer = makeProject('peer2');
    roots.push(local, peer);
    writeSoul(local, 'LOCAL_ONLY_MARKER');
    writeSoul(peer, 'PEER_ONLY_MARKER');

    process.chdir(join(local, '..'));

    const noArg = generateSnapshot();
    expect(noArg).toContain('LOCAL_ONLY_MARKER');
    expect(noArg).not.toContain('PEER_ONLY_MARKER');
  });

  it('a LOCAL vault with people renders person + roster, and no-arg still equals explicit-local', () => {
    const local = makeProject('local3');
    roots.push(local);
    writeSoul(local, 'LOCAL_SOUL_MARKER');
    writePeopleLayout(local, 'local');
    // Rung 1: two people means the ladder would otherwise depend on this
    // machine's git identity, which is not a property of the vault under test.
    process.env.DREAMCONTEXT_PERSON = 'local-ada';

    process.chdir(join(local, '..'));
    const noArg = generateSnapshot();
    const explicit = generateSnapshot(local);

    expect(noArg).toContain('## Person (Active — local Ada, `person:local-ada`)');
    expect(noArg).toContain('LOCAL_CONSTITUTION_MARKER');
    expect(noArg).toContain('## Other People (this vault)');
    expect(noArg).toContain('- **local Bob** (`person:local-bob`) — reviewer');
    // The pre-existing invariant, unchanged by the person block: the no-arg
    // default resolution is BYTE-IDENTICAL to passing that same root.
    expect(noArg).toBe(explicit);
  });

  it('a PEER render suppresses BOTH the person block and the roster (D14)', () => {
    const local = makeProject('local4');
    const peer = makeProject('peer4');
    roots.push(local, peer);
    writeSoul(local, 'LOCAL_SOUL_MARKER');
    writeSoul(peer, 'PEER_SOUL_MARKER');
    writePeopleLayout(local, 'local');
    writePeopleLayout(peer, 'peer');
    process.env.DREAMCONTEXT_PERSON = 'local-ada';

    process.chdir(join(local, '..'));
    const peerText = generateSnapshot(peer, { peer: true });

    // The peer's own content still renders…
    expect(peerText).toContain('PEER_SOUL_MARKER');
    // …but nothing about WHO. This machine's identity resolved against a peer's
    // roster is a category error, and the peer's binding is not this vault's
    // problem to narrate — so there is no constitution, no UNRESOLVED notice
    // (which is what an unpinned peer roster would otherwise produce), and no
    // roster of the peer's people.
    expect(peerText).not.toContain('## Person (Active');
    expect(peerText).not.toContain('## Person (Active — UNRESOLVED)');
    expect(peerText).not.toContain('## Other People');
    expect(peerText).not.toContain('PEER_CONSTITUTION_MARKER');
    expect(peerText).not.toContain('person:peer-');
    // And no leakage of the LOCAL person into a peer render either.
    expect(peerText).not.toContain('local-ada');
  });

  it('peer defaults to FALSE — the same root rendered without the flag keeps its person', () => {
    // `rootOverride` cannot stand in for "is a peer": doctor and the test suites
    // pass local roots through it, so the flag has to be explicit.
    const local = makeProject('local5');
    roots.push(local);
    writeSoul(local, 'LOCAL_SOUL_MARKER');
    writePeopleLayout(local, 'local');
    process.env.DREAMCONTEXT_PERSON = 'local-ada';

    expect(generateSnapshot(local)).toContain('## Person (Active — local Ada');
    expect(generateSnapshot(local, {})).toContain('## Person (Active — local Ada');
    expect(generateSnapshot(local, { peer: false })).toContain('## Person (Active — local Ada');
    expect(generateSnapshot(local, { peer: true })).not.toContain('## Person (Active');
  });
});
