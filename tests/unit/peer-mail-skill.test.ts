/**
 * Doc lock for PEER MAIL — item 8 of `knowledge/patterns/feature-integration-pattern.md`,
 * the item peer mail shipped without.
 *
 * Peer mail arrived with a full behavior suite (`peer-identity`, `peer-delivery`, the
 * `federation-*` family) and zero assertions that what the SKILL tells an agent matches
 * what the CLI actually offers. That is precisely the v0.11.0 Lab shape: the capability
 * works, the agent is told about it slightly wrongly, and every test stays green while the
 * agent reaches for a verb that does not exist — or never reaches at all.
 *
 * The strongest assertions here do not hardcode the contract. They PARSE it out of
 * `src/cli/commands/peer.ts` and compare against the docs, so a verb or a `--kind` added
 * tomorrow goes red until it is documented. Where a value is exported (the permission
 * mode, the mail directory) the test binds to the real export instead of a copy.
 *
 * Companion: `meeting-room-skill.test.ts` does the same for the Meeting Room.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEER_PERMISSION_MODE } from '../../src/lib/peer-delivery.js';
import { mailDir } from '../../src/lib/peer-mail.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

const SKILL_MD = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
const INTEGRATIONS_MD = readFileSync(join(ROOT, 'skill', 'references', 'integrations.md'), 'utf-8');
const CLI_REFERENCE_MD = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
const SLEEP_FEDERATION_MD = readFileSync(join(ROOT, 'agents', 'sleep-federation.md'), 'utf-8');
const PEER_CMD_TS = readFileSync(join(ROOT, 'src', 'cli', 'commands', 'peer.ts'), 'utf-8');
const PEER_AGENT_GEN_TS = readFileSync(join(ROOT, 'src', 'lib', 'peer-agent-gen.ts'), 'utf-8');
const SNAPSHOT_TS = readFileSync(join(ROOT, 'src', 'cli', 'commands', 'snapshot.ts'), 'utf-8');

/**
 * The subcommand names `registerPeerCommand` actually registers, read out of the source
 * rather than mirrored. Scoped to the body after `.command('peer')` so a `.command(...)`
 * belonging to a different command in the same file could never be counted.
 */
function registeredPeerVerbs(): string[] {
  const start = PEER_CMD_TS.indexOf(".command('peer')");
  expect(start, "the `peer` command registration was not found in peer.ts").toBeGreaterThan(-1);
  const body = PEER_CMD_TS.slice(start + 1);
  const verbs = new Set<string>();
  for (const m of body.matchAll(/\.command\(\s*'([a-z-]+)[^']*'/g)) verbs.add(m[1]);
  return [...verbs].sort();
}

/** The `--kind` values the CLI validates against, parsed from its own KINDS literal. */
function registeredKinds(): string[] {
  const m = PEER_CMD_TS.match(/const KINDS[^=]*=\s*\[([^\]]+)\]/);
  expect(m, 'the KINDS literal was not found in peer.ts').not.toBeNull();
  return m![1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
    .sort();
}

describe('peer mail — every registered CLI verb is documented', () => {
  const verbs = registeredPeerVerbs();

  it('parses a plausible verb set out of peer.ts', () => {
    // Sanity floor: a broken extraction returning nothing would make every
    // assertion below vacuously pass.
    expect(verbs.length).toBeGreaterThanOrEqual(6);
    expect(verbs).toContain('ask');
    expect(verbs).toContain('send');
  });

  it('names every verb in cli-reference.md — the table an agent looks a verb up in', () => {
    for (const verb of verbs) {
      expect(CLI_REFERENCE_MD, `cli-reference.md never names \`peer ${verb}\``).toContain(`peer ${verb}`);
    }
  });

  it('names every verb in the integrations.md protocol section', () => {
    const start = INTEGRATIONS_MD.indexOf('### Peer mail');
    expect(start, 'the Peer mail section is missing from integrations.md').toBeGreaterThan(-1);
    const section = INTEGRATIONS_MD.slice(start, INTEGRATIONS_MD.indexOf('\n### ', start + 5));
    for (const verb of verbs) {
      expect(section, `the Peer mail section never names \`${verb}\``).toContain(verb);
    }
  });

  it('documents every --kind the CLI accepts, and invents none', () => {
    const kinds = registeredKinds();
    expect(kinds).toEqual(['command', 'note', 'question']);
    for (const kind of kinds) {
      expect(INTEGRATIONS_MD, `--kind ${kind} is undocumented`).toContain(kind);
      expect(CLI_REFERENCE_MD, `--kind ${kind} is missing from cli-reference.md`).toContain(kind);
    }
  });
});

describe('peer mail — SKILL.md reaches the capability without being asked', () => {
  it('has a capabilities row naming peer mail and linking integrations.md', () => {
    expect(SKILL_MD).toContain('**Peer mail');
    expect(SKILL_MD).toContain('[integrations.md](references/integrations.md)');
  });

  it('names the ask verb in the capabilities row, not just the concept', () => {
    expect(SKILL_MD).toMatch(/dreamcontext peer ask <vault>/);
  });

  it('carries the ask-vs-recall litmus — the judgement call that makes the verb reachable', () => {
    // A capability an agent can name but cannot decide WHEN to use is not reachable.
    expect(SKILL_MD).toMatch(/recall returns what a peer WROTE DOWN/);
    expect(SKILL_MD).toMatch(/reach for ask when recall came back empty/i);
    expect(INTEGRATIONS_MD).toContain('**When to ask instead of recall**');
  });

  it('tells the agent a command is a request, not an order', () => {
    // Shipped in the snapshot footer too; the skill must not contradict it.
    expect(INTEGRATIONS_MD.toLowerCase()).toContain('never bypass');
  });
});

describe('peer mail — the docs quote the real constants, not a stale copy', () => {
  it('the permission mode the docs claim IS the exported constant', () => {
    expect(PEER_PERMISSION_MODE).toBe('auto');
    expect(INTEGRATIONS_MD).toContain(`--permission-mode ${PEER_PERMISSION_MODE}`);
    expect(INTEGRATIONS_MD).toContain('bypassPermissions');
  });

  it('the mail path the docs name IS the path mailDir() builds', () => {
    const rel = mailDir('<root>').replace('<root>/', '');
    expect(rel).toBe(join('state', '.peer-mail'));
    expect(INTEGRATIONS_MD).toContain(`${rel}/<id>.json`);
  });

  it('the snapshot heading the docs point at IS the heading snapshot.ts emits', () => {
    // "surfaces under `## Peer mail`" is a promise about another file's output.
    expect(SNAPSHOT_TS).toContain('## Peer mail');
    expect(INTEGRATIONS_MD).toContain('`## Peer mail`');
  });

  it('the envoy agent path the docs name matches the generator that owns the namespace', () => {
    const prefixMatch = PEER_AGENT_GEN_TS.match(/const PEER_AGENT_PREFIX = '([^']+)'/);
    expect(prefixMatch, 'PEER_AGENT_PREFIX not found in peer-agent-gen.ts').not.toBeNull();
    expect(INTEGRATIONS_MD).toContain(`.claude/agents/${prefixMatch![1]}<vault>.md`);
  });
});

describe('peer mail — sleep boundary is stated where sleep reads it', () => {
  it('sleep-federation is told mail is not its to drain', () => {
    // The two directories look alike and only one is a digest stream. Without this
    // line a sleep run consolidates one side of a conversation into a project fact.
    expect(SLEEP_FEDERATION_MD).toContain('state/.peer-mail/');
    expect(SLEEP_FEDERATION_MD).toContain('not yours to drain');
  });

  it('still names the federation inbox as the thing it DOES consume', () => {
    expect(SLEEP_FEDERATION_MD).toContain('state/.federation-inbox/');
  });
});
