/**
 * A reasoned exemption from the sleep-eval close gate (plan r3 § W2, r4 R4-2).
 *
 * Owner decision 2026-10-18: the eval runs only for the sub-tasks that change
 * what sleep files or learns; the others close through an exemption that names
 * its reason. `sleep eval exempt` is the owner's (refused from an agent
 * environment), refused without a reason and for a child that is not gated.
 * The gate honours an exemption only when the stored entry, the child's
 * journal entry and the `exempt` audit record all agree: a hand-written
 * `exemptions.json` grants nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command, CommanderError } from 'commander';
import { registerSleepEvalCommand } from '../../src/cli/commands/sleep-eval.js';
import { checkCloseGate, writeBaseline } from '../../src/lib/sleep-eval/report.js';
import { sleepEvalRoot } from '../../src/lib/sleep-eval/types.js';
import {
  EXEMPT_JOURNAL_LABEL,
  exemptJournalBody,
  exemptionFor,
  exemptionsPath,
  readExemptions,
} from '../../src/lib/sleep-eval/exemptions.js';
import { appendJournalEntry, readJournal } from '../../src/lib/task-journal.js';
import { listAudit, recordAudit } from '../../src/lib/task-audit.js';

const REASON = 'Owner decision 2026-10-18: C3 does not change what sleep files or learns.';

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN'];
const savedEnv: Record<string, string | undefined> = {};

function cardOf(name: string, status: string, extra: string[] = []): string {
  return [
    '---', `id: task_${name.replace(/[^a-z]/g, '').slice(0, 8)}`, `name: ${name}`, `status: ${status}`,
    'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', ...extra, '---', '',
    '## Why', '', 'Because.', '',
    '## Acceptance Criteria', '', '- [ ] Something', '',
  ].join('\n');
}

function seed(): void {
  writeFileSync(join(stateDir, 'gated-parent.md'), cardOf('gated-parent', 'in_progress'));
  writeFileSync(join(stateDir, 'free-parent.md'), cardOf('free-parent', 'in_progress'));
  writeFileSync(join(stateDir, 'cycles-child.md'), cardOf('cycles-child', 'in_review', ['parent_task: gated-parent']));
  writeFileSync(join(stateDir, 'sibling-child.md'), cardOf('sibling-child', 'in_review', ['parent_task: gated-parent']));
  writeFileSync(join(stateDir, 'free-child.md'), cardOf('free-child', 'in_review', ['parent_task: free-parent']));
  writeFileSync(join(stateDir, 'orphan.md'), cardOf('orphan', 'in_review'));
}

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  const sleep = program.command('sleep').exitOverride();
  registerSleepEvalCommand(sleep);
  for (const c of sleep.commands) { c.exitOverride(); for (const cc of c.commands) cc.exitOverride(); }
  try {
    await program.parseAsync(['node', 'dreamcontext', ...argv]);
  } catch (e) {
    if (e instanceof CommanderError) { process.exitCode = undefined; return 1; }
    throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

function gate(child: string) {
  return checkCloseGate(contextRoot, child, 'gated-parent');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-exempt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sleepEvalRoot(contextRoot), { recursive: true });
  writeBaseline(contextRoot, { runId: 'run-20261018-0000', parents: ['gated-parent'], at: '2026-10-18T00:00:00.000Z' });
  seed();
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  for (const k of AGENT_ENVS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const k of AGENT_ENVS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('sleep eval exempt: refusals', () => {
  it('1. is refused without --reason and with a whitespace-only reason', async () => {
    expect(await cli('sleep', 'eval', 'exempt', 'cycles-child')).toBe(1);
    expect(await cli('sleep', 'eval', 'exempt', 'cycles-child', '--reason', '   ')).toBe(1);
    expect(existsSync(exemptionsPath(contextRoot))).toBe(false);
    expect(readJournal(stateDir, 'cycles-child')).toHaveLength(0);
    expect(gate('cycles-child').ok).toBe(false);
  });

  it('2. is refused for a child that is not gated, and for a task with no parent', async () => {
    expect(await cli('sleep', 'eval', 'exempt', 'free-child', '--reason', REASON)).toBe(1);
    expect(await cli('sleep', 'eval', 'exempt', 'orphan', '--reason', REASON)).toBe(1);
    expect(readExemptions(contextRoot)).toHaveLength(0);
    expect(logs.join('\n')).toContain('not gated');
  });

  it('3. is refused from an agent environment, writing nothing', async () => {
    process.env.CLAUDECODE = '1';
    expect(await cli('sleep', 'eval', 'exempt', 'cycles-child', '--reason', REASON)).toBe(1);
    expect(existsSync(exemptionsPath(contextRoot))).toBe(false);
    expect(readJournal(stateDir, 'cycles-child')).toHaveLength(0);
    expect(listAudit(contextRoot)).toHaveLength(0);
  });
});

describe('sleep eval exempt: a real exemption', () => {
  it('4-7. opens the gate, journals the reason, lists in status and writes an exempt audit record', async () => {
    expect(gate('cycles-child').ok).toBe(false);
    expect(await cli('sleep', 'eval', 'exempt', 'cycles-child', '--reason', REASON)).toBe(0);

    // 4. the gate opens and names the reason
    const g = gate('cycles-child');
    expect(g).toMatchObject({ applies: true, ok: true });
    expect(g.message).toContain(REASON);

    // 5. the journal entry carries the reason
    const entry = readJournal(stateDir, 'cycles-child').find((j) => j.label === EXEMPT_JOURNAL_LABEL)!;
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe('status');
    expect(entry.body).toBe(exemptJournalBody(REASON));

    // 6. status --json lists it
    logs = [];
    expect(await cli('sleep', 'eval', 'status', '--json')).toBe(0);
    const status = JSON.parse(logs.join('\n')) as { exemptions: Array<{ child: string; reason: string; journalId: string }> };
    expect(status.exemptions).toEqual([expect.objectContaining({ child: 'cycles-child', reason: REASON, journalId: entry.id })]);

    // 7. the audit has an exempt record, via the CLI, with the same journal id
    const audit = listAudit(contextRoot, { kinds: ['exempt'] });
    expect(audit).toEqual([expect.objectContaining({ slug: 'cycles-child', via: 'cli', note: REASON, journalId: entry.id })]);
  });

  it('9. a sibling under the same gated parent stays blocked', async () => {
    expect(await cli('sleep', 'eval', 'exempt', 'cycles-child', '--reason', REASON)).toBe(0);
    expect(gate('sibling-child')).toMatchObject({ applies: true, ok: false });
  });
});

describe('the trail is what is trusted, not the store', () => {
  it('8. a hand-written exemptions.json entry with no journal entry leaves the gate closed', () => {
    writeFileSync(exemptionsPath(contextRoot), JSON.stringify({
      version: 1,
      exemptions: [{ child: 'cycles-child', parent: 'gated-parent', reason: REASON, by: 'owner', at: '2026-10-18T00:00:00.000Z', journalId: 'je_forged0001' }],
    }));
    expect(readExemptions(contextRoot)).toHaveLength(1);
    expect(exemptionFor(contextRoot, 'cycles-child')).toBeNull();
    expect(gate('cycles-child').ok).toBe(false);
  });

  it('8b. a journal entry with a different reason leaves the gate closed', () => {
    const je = appendJournalEntry(stateDir, 'cycles-child', { kind: 'status', label: EXEMPT_JOURNAL_LABEL, body: exemptJournalBody('some other reason') });
    recordAudit(contextRoot, { kind: 'exempt', slug: 'cycles-child', actor: 'owner', via: 'cli', note: REASON, journalId: je.id });
    writeFileSync(exemptionsPath(contextRoot), JSON.stringify({
      version: 1,
      exemptions: [{ child: 'cycles-child', parent: 'gated-parent', reason: REASON, by: 'owner', at: '2026-10-18T00:00:00.000Z', journalId: je.id }],
    }));
    expect(gate('cycles-child').ok).toBe(false);
  });

  it('11. a matching journal entry without an exempt audit record leaves the gate closed', () => {
    const je = appendJournalEntry(stateDir, 'cycles-child', { kind: 'status', label: EXEMPT_JOURNAL_LABEL, body: exemptJournalBody(REASON) });
    writeFileSync(exemptionsPath(contextRoot), JSON.stringify({
      version: 1,
      exemptions: [{ child: 'cycles-child', parent: 'gated-parent', reason: REASON, by: 'owner', at: '2026-10-18T00:00:00.000Z', journalId: je.id }],
    }));
    expect(exemptionFor(contextRoot, 'cycles-child')).toBeNull();
    expect(gate('cycles-child').ok).toBe(false);
    // an audit record for another journal id, or another task, does not count either
    recordAudit(contextRoot, { kind: 'exempt', slug: 'cycles-child', actor: 'owner', via: 'cli', note: REASON, journalId: 'je_other00001' });
    recordAudit(contextRoot, { kind: 'exempt', slug: 'sibling-child', actor: 'owner', via: 'cli', note: REASON, journalId: je.id });
    expect(gate('cycles-child').ok).toBe(false);
    // with the matching record, all three agree and the gate opens
    recordAudit(contextRoot, { kind: 'exempt', slug: 'cycles-child', actor: 'owner', via: 'cli', note: REASON, journalId: je.id });
    expect(gate('cycles-child').ok).toBe(true);
  });
});

describe('no refusal names the exempt command', () => {
  it('10. the gate refusal for an un-run child does not mention an exemption', () => {
    const g = gate('sibling-child');
    expect(g.ok).toBe(false);
    expect(g.message.toLowerCase()).not.toContain('exempt');
  });

  it('10b. no refusal message in the gate source names `sleep eval exempt`', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'sleep-eval', 'report.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export function checkCloseGate'));
    // the only mention is the comment explaining why refusals never name it
    expect(body).not.toMatch(/`[^`]*sleep eval exempt[^`]*`/);
  });
});

/**
 * Second-pass review, owner question (b): `exemptionFor` compares the journal body byte for
 * byte, so a reason that the journal write redacted, capped or reflowed would never open the
 * gate. These are the three reasons the owner gave for C2, C3 and C5, run through
 * `sleep eval exempt` exactly as written.
 */
describe('sleep eval exempt: the three owner reasons open the gate as written', () => {
  const REASONS: Array<[string, string]> = [
    ['subtasks-child', 'Owner decision 2026-10-18 (scope card, item 3): the sleep eval runs only for C4 and C7, which change what sleep files or learns; C2 (sub-tasks, context packet) does not change sleep\'s output.'],
    ['cycles-child', 'Owner decision 2026-10-18 (scope card, item 3): the sleep eval runs only for C4 and C7; C3 (cycles, queue, releases) does not change what sleep files or learns, and sleep never places anything in a cycle.'],
    ['ui-child', 'Owner decision 2026-10-18 (scope card, item 3): the sleep eval runs only for C4 and C7; C5 (the task UI) does not change what sleep files or learns.'],
  ];

  for (const [child, reason] of REASONS) {
    it(`${child}: exempt → exemptionFor matches, and the gate opens`, async () => {
      if (!existsSync(join(stateDir, `${child}.md`))) {
        writeFileSync(join(stateDir, `${child}.md`), cardOf(child, 'in_review', ['parent_task: gated-parent']));
      }
      expect(gate(child).ok).toBe(false);
      expect(await cli('sleep', 'eval', 'exempt', child, '--reason', reason)).toBe(0);
      const ex = exemptionFor(contextRoot, child);
      expect(ex?.reason).toBe(reason);
      const entry = readJournal(stateDir, child).find((j) => j.id === ex?.journalId);
      expect(entry?.body).toBe(exemptJournalBody(reason));
      expect(gate(child).ok).toBe(true);
    });
  }
});
