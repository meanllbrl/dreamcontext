/**
 * Standing recall regression set, hook half: the REAL `hook user-prompt-submit` (built CLI) on the turn
 * shapes the recall evals never held (2026-11-20 diagnosis). The gold corpus was built from the product's
 * own stripped query, measured knowledge-file picks only (never a skill), replayed no once-per-session gate,
 * and scored a judge's 0 picks as "silent = correct". Each case below is one of those blind spots.
 *
 * Synthetic fixtures only (tests/helpers/recall-regression-fixtures.ts). Recall runs model-free (raw BM25)
 * except the judge case, which uses a stub judge: no network, no paid call.
 *
 * `it.fails` = broken on today's dev, kept in the suite on purpose: green while broken, RED once the fix
 * lands, and the fixing change flips it to `it`. Each one names the change that broke it and the fix it
 * waits for: 1 frame subject back into the query, 2 name the matching skill on every relevant turn, 4 an explicit
 * outcome when the judge picks 0 (Doc's 2026-11-20 recall regression diagnosis, in the brain's learning log).
 * The plain `it` cases are controls: they prove the fixture reaches the hook, so an `it.fails` cannot pass
 * on a broken setup.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliWithStdin } from '../helpers/cli-stdin.js';
import {
  CONTACT_SKILL, FILLER_SKILLS, FRAMED, NUMBER_TURN, SUBJECT_DOC, VIDEO_SKILL, VIDEO_TURN,
} from '../helpers/recall-regression-fixtures.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const RECALL_HEAD = '— Memory recall';

let project: string;
let home: string;
let env: NodeJS.ProcessEnv;

function scaffold(root: string): void {
  const ctx = join(root, '_dream_context');
  for (const d of ['core', 'knowledge/features', 'state']) mkdirSync(join(ctx, d), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: test\n---\nTest soul.');
  writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({ debt: 2, sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [] }));
  writeFileSync(join(ctx, SUBJECT_DOC.rel), SUBJECT_DOC.body);
}

function addSkill(s: { name: string; md: string }): void {
  for (const f of FILLER_SKILLS) writeSkill(f);
  writeSkill(s);
}

function writeSkill(s: { name: string; md: string }): void {
  const dir = join(project, '.claude', 'skills', s.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), s.md);
}

function ask(prompt: string, session = 'reg-1', e: NodeJS.ProcessEnv = env): string {
  return runCliWithStdin(CLI, ['hook', 'user-prompt-submit'], JSON.stringify({ session_id: session, prompt }), { cwd: project, env: e, timeout: 15_000 });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-recall-reg-'));
  home = mkdtempSync(join(tmpdir(), 'dc-recall-reg-home-'));
  scaffold(project);
  env = { ...process.env, HOME: home, DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_RECALL_MODE: 'raw', DREAMCONTEXT_RECALL_JUDGE: 'off' };
  delete env.DREAMCONTEXT_CHAT_TAB;
  delete env.DREAMCONTEXT_TAB_SESSION;
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('1 · framed turn: the subject in the frame reaches recall', () => {
  it('control: the subject written as plain words brings the file', () => {
    expect(ask('is the Northwind invoice export ledger CSV tested?')).toContain(SUBJECT_DOC.rel);
  });

  // REGRESSED since 0.41.20 (24f62d121: ownerWords cuts every aboutHeads block out of the query).
  // Waits for product fix 1 (the frame subject goes back into the query or to the judge as context).
  it('agenda line', () => { expect(ask(FRAMED.agenda)).toContain(SUBJECT_DOC.rel); });
  it('reply quote', () => { expect(ask(FRAMED.reply)).toContain(SUBJECT_DOC.rel); });
  it('card quote', () => { expect(ask(FRAMED.card)).toContain(SUBJECT_DOC.rel); });
  it('task header', () => { expect(ask(FRAMED.task)).toContain(SUBJECT_DOC.rel); });
});

describe('2 · number-only owner turn: the covering skill is named', () => {
  it('control: the skill matches the turn, so the gate fires', () => {
    addSkill(CONTACT_SKILL);
    expect(ask(NUMBER_TURN)).toMatch(/Before you act/);
  });

  // NEVER BUILT: the hook only says "review the skills", never which one. A turn that is only a phone
  // number gives the agent no word to match the catalogue on. Waits for product fix 2 (name the skill).
  it('the hook names the matching skill', () => {
    addSkill(CONTACT_SKILL);
    expect(ask(NUMBER_TURN)).toContain(CONTACT_SKILL.name);
  });
});

describe('3 · turn N>1 of a long session: the skill reminder survives', () => {
  const longSession = (): NodeJS.ProcessEnv => {
    const e = { ...env };
    delete e.DREAMCONTEXT_PROMPT_ONCE; // the shipped once-per-session path, as a long Super session runs it
    return e;
  };

  it('control: turn 3 reaches the gate (it prints the short reminder), so a silent turn cannot pass below', () => {
    addSkill(VIDEO_SKILL);
    const e = longSession();
    ask('how does the Northwind invoice export work', 'long-0', e);
    ask('and the ledger CSV columns?', 'long-0', e);
    expect(ask(VIDEO_TURN, 'long-0', e)).toMatch(/Before (acting|you act)/);
  });

  it('control: turn 1 prints the full gate with the skill review line', () => {
    addSkill(VIDEO_SKILL);
    expect(ask(VIDEO_TURN, 'long-1', longSession())).toMatch(/REVIEW the skills/);
  });

  // REGRESSED since 0.41.20 (24f62d121: the gate prints in full once per session, then
  // CONTEXT_GATE_REMINDER, which has no skill in it). Waits for product fix 2.
  it('turn 3 still tells the agent to use a skill', () => {
    addSkill(VIDEO_SKILL);
    const e = longSession();
    ask('how does the Northwind invoice export work', 'long-2', e);
    ask('and the ledger CSV columns?', 'long-2', e);
    // Not the authorization line's "goal-skill": a word about using a skill.
    expect(ask(VIDEO_TURN, 'long-2', e)).toMatch(/(?<!-)\bskills?\b/i);
  });

  it('turn 3 names the strongly matching skill', () => {
    addSkill(VIDEO_SKILL);
    const e = longSession();
    ask('how does the Northwind invoice export work', 'long-3', e);
    ask('and the ledger CSV columns?', 'long-3', e);
    expect(ask(VIDEO_TURN, 'long-3', e)).toContain(VIDEO_SKILL.name);
  });
});

// The stub judge is a #!/bin/sh script: Windows cannot spawn it, the judge would count as "could not start"
// and the BM25 fallback would answer, so neither case would test the judge there.
describe.skipIf(process.platform === 'win32')('4 · the judge picks 0: the turn is not silently empty', () => {
  const judgeEnv = (result: string): NodeJS.ProcessEnv => {
    const bin = join(home, `judge-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${JSON.stringify({ result, total_cost_usd: 0.006, is_error: false })}'\n`);
    chmodSync(bin, 0o755);
    return { ...env, DREAMCONTEXT_SKILLS_HOOK: '0', DREAMCONTEXT_RECALL_MODE: 'haiku', DREAMCONTEXT_RECALL_JUDGE: 'on', DREAMCONTEXT_RECALL_JUDGE_BIN: bin };
  };

  it('control: a judge that picks the file delivers it', () => {
    expect(ask('how does the Northwind invoice export work', 'judge-1', judgeEnv('c0: needed\n{"c0": 2}'))).toContain(SUBJECT_DOC.rel);
  });

  // REGRESSED since 0.41.21 (a58ce80de: JUDGE_FALLBACK = 'nothing'). A judge that picks nothing on a turn
  // whose subject plainly matches a file leaves no recall block and no mark that recall ran and found
  // nothing, so the agent cannot tell "nothing fits" from "recall did not run". Waits for product fix 4:
  // either a fallback hit or an explicit empty marker, decided by a measurement.
  it.fails('a judge that picks nothing leaves a fallback or a marked empty', () => {
    const out = ask('how does the Northwind invoice export work', 'judge-0', judgeEnv('{}'));
    // A fallback block, or a line that says recall found nothing (any wording with "recall" and a no/none/empty/0).
    expect(out.includes(RECALL_HEAD) || /recall[^\n]*\b(nothing|none|no|empty|0)\b/i.test(out)).toBe(true);
  });
});
