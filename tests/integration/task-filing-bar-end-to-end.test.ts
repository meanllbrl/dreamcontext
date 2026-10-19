import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEmbedModelDownloaded } from '../../src/lib/embeddings/embedder.js';

/**
 * B, end to end through the REAL binary: the bar, the cap, the tombstone and
 * the `--into` marker. Unit tests prove the predicate; this proves the wiring —
 * that `tasks create` actually consults it and actually refuses.
 *
 * Two blocks cover the neighbor + declined gates:
 *
 *  - MODEL-FREE: a fresh vault has no embedding cache, so the semantic gates are
 *    OFF. That is not a gap in the coverage, it IS an acceptance criterion — the
 *    bar must PASS and SAY SO. The declined ledger's exact-key half needs no
 *    model at all and is proven here too.
 *  - MODEL-GATED (`describe.skipIf(!isEmbedModelDownloaded())`): the merge band,
 *    the review band, `--neighbor-checked` and `--declined-checked` through the
 *    real binary against real vectors. Skipped where the ~113 MB model is not on
 *    disk; this suite NEVER triggers a download.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
let root = '';

interface CliOpts {
  /** Vault to run in. Defaults to the per-test `root`. */
  cwd?: string;
  /** Extra env for THIS invocation — the dedup thresholds are read per process. */
  env?: Record<string, string>;
  /** A real model load costs seconds; the default suits the model-free calls. */
  timeout?: number;
  /**
   * Run the child at the lowest scheduling priority.
   *
   * Set for every model-gated call. Loading the ONNX model costs ~1.8 core-seconds
   * per invocation, and vitest's `forks` pool already saturates the box — measured,
   * this block alone pushed three unrelated 5s-default suites that shell out to the
   * real binary (github-pull, setup-drift-update, migration-update-note) over their
   * timeout, while the same run without this file was fully green. Our own timeout
   * is generous, so yielding costs this suite nothing and stops it failing others'.
   */
  lowPriority?: boolean;
}

function cli(args: string, opts: CliOpts = {}): { out: string; code: number } {
  try {
    // `nice` is POSIX-only, like the rest of this file's shell usage (`2>&1`).
    const out = execSync(`${opts.lowPriority ? 'nice -n 19 ' : ''}node ${CLI} ${args} 2>&1`, {
      cwd: opts.cwd ?? root,
      encoding: 'utf-8',
      timeout: opts.timeout ?? 30000,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

const taskFile = (slug: string, atRoot = root) => join(atRoot, '_dream_context', 'state', `${slug}.md`);
const sleepPath = (atRoot = root) => join(atRoot, '_dream_context', 'state', '.sleep.json');
const declinedPath = (atRoot = root) => join(atRoot, '_dream_context', 'state', '.task-declined.json');

/** Stamp the epoch the way `sleep start` does. `.sleep.json` is written lazily
 *  (the hooks create it), so a fresh brain may not have one yet. */
function startCycle(atRoot = root): void {
  const base = existsSync(sleepPath(atRoot)) ? JSON.parse(readFileSync(sleepPath(atRoot), 'utf8')) : {
    debt: 0, last_sleep: null, last_sleep_summary: null,
    sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    compaction_log: [], pendingMigrationNotices: [],
  };
  base.sleep_started_at = new Date().toISOString();
  base.cycle_tasks_filed = [];
  writeFileSync(sleepPath(atRoot), JSON.stringify(base, null, 2));
}

const INIT = 'init --yes --name "T" --description "d" --stack "Node" --priority "p"';
const WHY = 'Users lose the draft when the tab reloads because nothing persists it before unload.';
/** Non-empty (the CLI has always required that) but under the sleep bar's floor. */
const THIN_WHY = 'tidy this up';

/** The line the bar prints when the semantic gates could not run. Its ABSENCE is
 *  what makes a model-gated assertion evidence rather than a coincidence. */
const SKIP_NOTICE = 'neighbor check skipped';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-bar-e2e-'));
  cli(INIT);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('tasks create under a live sleep cycle', () => {
  it('files freely when no cycle is running', () => {
    const r = cli(`tasks create "a normal task" --why "${THIN_WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile('a-normal-task'))).toBe(true);
  });

  it('REFUSES an unjustified task during a cycle, and writes no file', () => {
    startCycle();
    const r = cli(`tasks create "some vague chore" --why "${THIN_WHY}"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('at least 40 characters');
    expect(existsSync(taskFile('some-vague-chore'))).toBe(false);
  });

  it('accepts the same task WITH a real justification', () => {
    startCycle();
    const r = cli(`tasks create "a justified task" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile('a-justified-task'))).toBe(true);
  });

  it('lets a HUMAN through mid-cycle, and tells an unknown caller how', () => {
    startCycle();
    expect(cli(`tasks create "my own task" --by human --why "${THIN_WHY}"`).code).toBe(0);
    expect(cli(`tasks create "another vague one" --why "${THIN_WHY}"`).out).toContain('--by human');
  });

  it('counts filed tasks against the cap and then refuses', () => {
    cli('sleep config set max-new-tasks 2');
    startCycle();
    expect(cli(`tasks create "first one" --by sleep --why "${WHY}"`).code).toBe(0);
    expect(cli(`tasks create "second one" --by sleep --why "${WHY}"`).code).toBe(0);
    const third = cli(`tasks create "third one" --by sleep --why "${WHY}"`);
    expect(third.code).toBe(1);
    expect(third.out).toContain('2/2');
    expect(existsSync(taskFile('third-one'))).toBe(false);
  });

  it('a human is not counted against the cap', () => {
    cli('sleep config set max-new-tasks 1');
    startCycle();
    cli(`tasks create "human one" --by human --why "${THIN_WHY}"`);
    cli(`tasks create "human two" --by human --why "${THIN_WHY}"`);
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual([]);
  });

  it('the counter is cleared when the cycle ends', () => {
    startCycle();
    cli(`tasks create "counted" --by sleep --why "${WHY}"`);
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual(['counted']);
    cli('sleep done "wrapped up"');
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual([]);
  });
});

describe('the pre-existing why requirement', () => {
  it('refuses an empty why with a NON-ZERO exit, so a script can tell', () => {
    const r = cli('tasks create "no reason given"');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Every task must say why it exists');
    expect(existsSync(taskFile('no-reason-given'))).toBe(false);
  });
});

describe('tombstones through the CLI', () => {
  it('deleting a task records it, and `tombstones` lists it', () => {
    cli(`tasks create "a doomed task" --why "${WHY}"`);
    cli('tasks delete "a doomed task" --yes');
    const out = cli('tasks tombstones').out;
    expect(out).toContain('a-doomed-task');
    expect(out).toContain('dropped, not merged');
  });

  it('--into records where the work went', () => {
    cli(`tasks create "the real home" --why "${WHY}"`);
    cli(`tasks create "a duplicate chore" --why "${WHY}"`);
    const del = cli('tasks delete "a duplicate chore" --yes --into "the real home"');
    expect(del.code).toBe(0);
    expect(del.out).toContain('absorbed by the-real-home');
    expect(cli('tasks tombstones').out).toContain('→ absorbed by the-real-home');
  });

  it('--into refuses a target that does not exist, and deletes nothing', () => {
    cli(`tasks create "a task" --why "${WHY}"`);
    const r = cli('tasks delete "a task" --yes --into "no-such-task"');
    expect(r.code).toBe(1);
    expect(existsSync(taskFile('a-task'))).toBe(true);
  });

  it('THE REGRESSION: a merged-away slug cannot be re-filed by a cycle', () => {
    cli(`tasks create "the real home" --why "${WHY}"`);
    cli(`tasks create "a duplicate chore" --why "${WHY}"`);
    cli('tasks delete "a duplicate chore" --yes --into "the real home"');

    startCycle();
    const r = cli(`tasks create "a duplicate chore" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the-real-home');
    expect(existsSync(taskFile('a-duplicate-chore'))).toBe(false);
  });

  it('a rename leaves a marker pointing at the new slug', () => {
    cli(`tasks create "the old name" --why "${WHY}"`);
    cli('tasks rename "the old name" "the new name"');
    expect(cli('tasks tombstones').out).toContain('the-old-name');
    expect(cli('tasks tombstones').out).toContain('absorbed by the-new-name');
  });

  it('the tombstone ledger is brain CONTENT — it is not gitignored', () => {
    cli(`tasks create "x" --why "${WHY}"`);
    cli('tasks delete "x" --yes');
    const gi = join(root, '_dream_context', '.gitignore');
    if (existsSync(gi)) expect(readFileSync(gi, 'utf8')).not.toContain('.task-tombstones.json');
    expect(existsSync(join(root, '_dream_context', 'state', '.task-tombstones.json'))).toBe(true);
  });
});

// ─── The semantic gates when they CANNOT run (no embedding cache) ────────────

describe('the bar says when the semantic gates did not run', () => {
  it('files the task and prints the skip notice — silence would read as a clean check', () => {
    startCycle();
    const r = cli(`tasks create "a justified task" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile('a-justified-task'))).toBe(true);
    expect(r.out).toContain(SKIP_NOTICE);
    // The notice must cover BOTH skipped gates: a specialist told only about the
    // neighbor check would assume the declined ledger was matched semantically.
    expect(r.out).toContain('declined ideas were matched by exact slug only');
  });

  it('`tasks create --help` documents the review-band escape hatch', () => {
    expect(cli('tasks create --help').out).toContain('--neighbor-checked');
  });

  it('`embed dedup --if-present` is a clean no-op on a vault with no index', () => {
    const r = cli('embed dedup --title x --types task --stdin --if-present --json < /dev/null');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ verdict: 'unknown', reason: 'no-embedding-cache' });
  });
});

// ─── The declined ledger (exact-key half — no model needed) ──────────────────

const DECLINE_TOPIC = 'Add a dark mode toggle to the settings page';
const DECLINE_KEY = 'add-a-dark-mode-toggle-to-the-settings-page';
const DECLINE_REASON = 'The owner said the app follows the OS theme and a manual toggle is scope we are not taking.';

describe('the declined ledger through the CLI', () => {
  const decline = (topic = DECLINE_TOPIC, reason = DECLINE_REASON) =>
    cli(`tasks decline "${topic}" --reason "${reason}"`);

  it('records an idea, lists it, and lifts it again', () => {
    expect(decline().code).toBe(0);
    expect(existsSync(declinedPath())).toBe(true);
    expect(JSON.parse(readFileSync(declinedPath(), 'utf8'))[0]).toMatchObject({
      key: DECLINE_KEY, topic: DECLINE_TOPIC, reason: DECLINE_REASON,
    });

    const list = cli('tasks declined');
    expect(list.out).toContain(DECLINE_KEY);
    expect(list.out).toContain(DECLINE_REASON);
    expect(JSON.parse(cli('tasks declined --json').out)).toHaveLength(1);

    expect(cli(`tasks undecline ${DECLINE_KEY}`).code).toBe(0);
    expect(JSON.parse(readFileSync(declinedPath(), 'utf8'))).toEqual([]);
  });

  it('refuses a reason nobody could act on, and writes nothing', () => {
    const r = decline(DECLINE_TOPIC, 'nope');
    expect(r.code).toBe(1);
    expect(r.out).toContain('at least 20 characters');
    expect(existsSync(declinedPath())).toBe(false);
  });

  it('refuses to decline a LIVE task — that idea became work, so close it instead', () => {
    cli(`tasks create "${DECLINE_TOPIC}" --why "${WHY}"`);
    const r = decline();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`tasks status ${DECLINE_KEY} cancelled`);
    expect(existsSync(declinedPath())).toBe(false);
  });

  it('ACCEPTS a tombstoned slug — the task is gone but the idea can still recur', () => {
    cli(`tasks create "${DECLINE_TOPIC}" --why "${WHY}"`);
    cli(`tasks delete "${DECLINE_TOPIC}" --yes`);
    expect(decline().code).toBe(0);
    expect(cli('tasks declined').out).toContain(DECLINE_KEY);
  });

  it('undecline reports honestly when the key is unknown', () => {
    const r = cli('tasks undecline no-such-idea');
    expect(r.code).toBe(1);
    expect(r.out).toContain('No declined idea with key');
  });

  it('the declined ledger is brain CONTENT — it is not gitignored', () => {
    decline();
    const gi = join(root, '_dream_context', '.gitignore');
    if (existsSync(gi)) expect(readFileSync(gi, 'utf8')).not.toContain('.task-declined.json');
    expect(existsSync(declinedPath())).toBe(true);
  });
});

describe('a declined idea cannot be re-filed by a cycle', () => {
  const decline = () => cli(`tasks decline "${DECLINE_TOPIC}" --reason "${DECLINE_REASON}"`);

  it('REFUSES the exact idea with the date, the topic and the way back', () => {
    decline();
    startCycle();
    const r = cli(`tasks create "${DECLINE_TOPIC}" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Declined on \d{4}-\d{2}-\d{2}/);
    expect(r.out).toContain(DECLINE_TOPIC);
    expect(r.out).toContain(`tasks undecline ${DECLINE_KEY}`);
    expect(existsSync(taskFile(DECLINE_KEY))).toBe(false);
  });

  it('lets the same task through once the decline is lifted awake', () => {
    decline();
    startCycle();
    expect(cli(`tasks create "${DECLINE_TOPIC}" --by sleep --why "${WHY}"`).code).toBe(1);
    expect(cli(`tasks undecline ${DECLINE_KEY}`).code).toBe(0);
    const r = cli(`tasks create "${DECLINE_TOPIC}" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile(DECLINE_KEY))).toBe(true);
  });

  it('never checks a HUMAN — a person may file what a cycle may not', () => {
    decline();
    startCycle();
    const r = cli(`tasks create "${DECLINE_TOPIC}" --by human --why "${THIN_WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile(DECLINE_KEY))).toBe(true);
  });
});

// ─── The semantic gates when they CAN run (real model, real vectors) ─────────

/**
 * Seeded vault: ONE near-verbatim twin plus ONE topically distinct decoy.
 *
 * NOT two twins: they would score within a hair of each other and fail the MERGE
 * margin gate (top1 − top2 ≥ DEDUP_MERGE_MARGIN), turning the merge case into a
 * review one. Measured here (e5-small q8): candidate → twin 0.9358, candidate →
 * decoy 0.8163, margin 0.1195. The bands are then placed with the documented
 * `DREAMCONTEXT_DEDUP_*` env overrides, read per child process, so each case
 * exercises a chosen band without betting on an exact cosine.
 */
const TWIN_NAME = 'The draft is lost when the tab reloads before anything persists it';
const TWIN_SLUG = 'the-draft-is-lost-when-the-tab-reloads-before-anything-persists-it';
const TWIN_DESC = 'Persist the composer draft to localStorage on input';
const DECOY_NAME = 'Weekly billing export drops the currency column for refunded invoices';
const DECOY_WHY = 'Finance reconciles refunds by hand every Monday because the export omits the currency column.';
/** Near-verbatim restatement of the twin, with a DIFFERENT slug (an identical one
 *  would be refused by the pre-existing "task already exists" check and never
 *  reach the bar). */
const CANDIDATE_NAME = 'Draft is lost when the tab reloads before anything persists it';
const CANDIDATE_SLUG = 'draft-is-lost-when-the-tab-reloads-before-anything-persists-it';

const REWORD_NAME = 'Ship a dark theme switch in settings';
const REWORD_SLUG = 'ship-a-dark-theme-switch-in-settings';
const REWORD_WHY = 'Users read at night and the owner asked for a way to force the dark palette from the settings page.';

/** Measured twin cosine is 0.9358, so 0.90 puts it in MERGE and leaves the decoy
 *  (0.8163) out. Margin 0 keeps the case about the ABSOLUTE band even if a future
 *  model moves the runner-up. */
const MERGE_BAND = { DREAMCONTEXT_DEDUP_MERGE: '0.90', DREAMCONTEXT_DEDUP_MERGE_MARGIN: '0' };
/** Merge out of reach, review below the twin → the review band. */
const REVIEW_BAND = { DREAMCONTEXT_DEDUP_MERGE: '0.999', DREAMCONTEXT_DEDUP_REVIEW: '0.9' };
/** Both bands out of reach → gate 5 returns `create`, so a refusal below it
 *  provably came from gate 6 (declined) and not from the neighbor gate. */
const CREATE_BAND = { DREAMCONTEXT_DEDUP_MERGE: '0.999', DREAMCONTEXT_DEDUP_REVIEW: '0.999' };

const MODEL_READY = isEmbedModelDownloaded();
/** A real model load plus an additive refresh; measured ~1.5–3 s per call here. */
const MODEL_TIMEOUT = 120_000;

// `describe.skipIf`, not `it.skipIf`: this suite's beforeAll seeds a vault and
// runs a real `embed refresh`, and a skipped IT still runs its suite's hooks — on
// a machine with no model that would be a pointless failure instead of a skip.
describe.skipIf(!MODEL_READY)('the semantic gates through the real binary (model required)', () => {
  let mroot = '';
  const mcli = (args: string, env: Record<string, string> = {}) =>
    cli(args, { cwd: mroot, env, timeout: MODEL_TIMEOUT, lowPriority: true });
  /** Re-index after anything that WRITES a task file. The bar needs ≥80% of the
   *  task corpus already vectorised (below that it refuses to cold-build inline
   *  and turns the gates OFF) — in a 2-file vault one new file is 33% uncovered,
   *  which would make every later case pass vacuously. */
  const reindex = () => expect(mcli('embed refresh').code).toBe(0);
  /** Every model-gated assertion is only evidence if the gates actually ran. */
  const expectGatesLive = (out: string) => expect(out).not.toContain(SKIP_NOTICE);

  beforeAll(() => {
    mroot = mkdtempSync(join(tmpdir(), 'dc-bar-e2e-model-'));
    expect(cli(INIT, { cwd: mroot, timeout: MODEL_TIMEOUT, lowPriority: true }).code).toBe(0);
    expect(mcli(`tasks create "${TWIN_NAME}" --by human -d "${TWIN_DESC}" --why "${WHY}"`).code).toBe(0);
    expect(mcli(`tasks create "${DECOY_NAME}" --by human --why "${DECOY_WHY}"`).code).toBe(0);
    reindex();
    startCycle(mroot);
  }, MODEL_TIMEOUT);

  afterAll(() => {
    if (mroot) rmSync(mroot, { recursive: true, force: true });
  });

  it('MERGE band: refuses a near-verbatim twin, names it, and writes no file', () => {
    const r = mcli(
      `tasks create "${CANDIDATE_NAME}" --by sleep -d "${TWIN_DESC}" --why "${WHY}"`,
      MERGE_BAND,
    );
    expectGatesLive(r.out);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`\`${TWIN_SLUG}\` already covers this`);
    expect(r.out).toContain(`dreamcontext tasks insert ${TWIN_SLUG} acceptance_criteria`);
    expect(existsSync(taskFile(CANDIDATE_SLUG, mroot))).toBe(false);
  }, MODEL_TIMEOUT);

  it('MERGE band has no --neighbor-checked escape — only `--by human` gets past it', () => {
    const r = mcli(
      `tasks create "${CANDIDATE_NAME}" --by sleep -d "${TWIN_DESC}" --why "${WHY}" --neighbor-checked ${TWIN_SLUG}`,
      MERGE_BAND,
    );
    expectGatesLive(r.out);
    expect(r.code).toBe(1);
    expect(r.out).toContain('already covers this');
    expect(existsSync(taskFile(CANDIDATE_SLUG, mroot))).toBe(false);
  }, MODEL_TIMEOUT);

  it('REVIEW band: refuses and asks the specialist to name the neighbor', () => {
    const r = mcli(
      `tasks create "${CANDIDATE_NAME}" --by sleep -d "${TWIN_DESC}" --why "${WHY}"`,
      REVIEW_BAND,
    );
    expectGatesLive(r.out);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Nearest task is \`${TWIN_SLUG}\``);
    expect(r.out).toContain(`--neighbor-checked ${TWIN_SLUG}`);
    expect(existsSync(taskFile(CANDIDATE_SLUG, mroot))).toBe(false);
  }, MODEL_TIMEOUT);

  it('REVIEW band: naming the WRONG neighbor is not proof of having looked', () => {
    const r = mcli(
      `tasks create "${CANDIDATE_NAME}" --by sleep -d "${TWIN_DESC}" --why "${WHY}" --neighbor-checked some-other-task`,
      REVIEW_BAND,
    );
    expectGatesLive(r.out);
    expect(r.code).toBe(1);
    expect(r.out).toContain('which is not the nearest task');
    expect(existsSync(taskFile(CANDIDATE_SLUG, mroot))).toBe(false);
  }, MODEL_TIMEOUT);

  it('REVIEW band: --neighbor-checked <the neighbor> files the task and logs the verdict', () => {
    const r = mcli(
      `tasks create "${CANDIDATE_NAME}" --by sleep -d "${TWIN_DESC}" --why "${WHY}" --neighbor-checked ${TWIN_SLUG}`,
      REVIEW_BAND,
    );
    expectGatesLive(r.out);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile(CANDIDATE_SLUG, mroot))).toBe(true);

    // The create IS a dedup decision: it must land in the log `sleep done` renders
    // as the cycle's "Semantic dedup since epoch" digest.
    const log = readFileSync(join(mroot, '_dream_context', '.embeddings', 'dedup-log.jsonl'), 'utf8')
      .trim().split('\n');
    const entry = JSON.parse(log[log.length - 1]);
    expect(entry).toMatchObject({
      type: 'task',
      verdict: 'review',
      source: 'filing-bar',
      slug: CANDIDATE_SLUG,
      topDocKey: `task/${TWIN_SLUG}`,
      neighborChecked: TWIN_SLUG,
    });

    reindex();   // a third task file now exists — restore the coverage invariant
  }, MODEL_TIMEOUT);

  it('DECLINED, reworded: refuses a match the exact-key gate cannot see, and --declined-checked lifts it', () => {
    expect(mcli(`tasks decline "${DECLINE_TOPIC}" --reason "${DECLINE_REASON}"`).code).toBe(0);

    // CREATE_BAND puts gate 5 out of reach, so this refusal can only be gate 6.
    const refused = mcli(`tasks create "${REWORD_NAME}" --by sleep --why "${REWORD_WHY}"`, CREATE_BAND);
    expectGatesLive(refused.out);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('Looks like a declined idea');
    expect(refused.out).toMatch(/declined \d{4}-\d{2}-\d{2}/);
    expect(refused.out).toContain(`--declined-checked ${DECLINE_KEY}`);
    expect(existsSync(taskFile(REWORD_SLUG, mroot))).toBe(false);

    const lifted = mcli(
      `tasks create "${REWORD_NAME}" --by sleep --why "${REWORD_WHY}" --declined-checked ${DECLINE_KEY}`,
      CREATE_BAND,
    );
    expectGatesLive(lifted.out);
    expect(lifted.code).toBe(0);
    expect(existsSync(taskFile(REWORD_SLUG, mroot))).toBe(true);

    reindex();   // another task file — leave the vault at the coverage invariant
  }, MODEL_TIMEOUT);
});
