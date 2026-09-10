import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  foldKey,
  foldKeys,
  keysAlign,
  displayName,
  slashNameFor,
  loadPatterns,
  matchPatterns,
  syncPatternShims,
  syncPatternShimsIfStale,
  selectForInjection,
  patternsFingerprint,
  loadPatternsReporting,
  commandsDir,
  MAX_PATTERN_FILE_BYTES,
  FIRST_MATCH_CEILING_FACTOR,
  MAX_PATTERN_MATCHES,
} from '../../src/lib/patterns.js';

/**
 * Spec for pattern triggering — the mechanism that makes a documented pattern
 * reach the agent without anyone authoring trigger phrases for it.
 *
 * The bug these lock down, measured on the real vaults: a user typing "özetle"
 * got nothing, because the shared recall tokenizer produced THREE different
 * stems for one word ("özetle"→`özetl`, the ascii filename→`ozeti`, the
 * diacritic title→`özeti`) and patterns had no gate of their own to fire.
 */

let ROOT: string;
let PROJECT: string;

function writePattern(name: string, frontmatter: string, body = ''): void {
  mkdirSync(join(ROOT, 'knowledge', 'patterns'), { recursive: true });
  writeFileSync(join(ROOT, 'knowledge', 'patterns', `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
}

beforeAll(() => {
  PROJECT = mkdtempSync(join(tmpdir(), 'dc-patterns-'));
  ROOT = join(PROJECT, '_dream_context');
  mkdirSync(ROOT, { recursive: true });

  // Modelled on the real Tilki pattern this feature was built for: a Turkish
  // pattern whose `name:` merely repeats its ascii filename.
  writePattern(
    'plan-ozeti-mehmete-nasil-anlatilir',
    "name: plan-ozeti-mehmete-nasil-anlatilir\ndescription: Plan sunma kalıbı. Her plan sunumunda zorunludur.",
    "# Plan özeti Mehmet'e nasıl anlatılır\n\n## Kalıp\n\nDört blok.",
  );
  // An English pattern, to prove cross-pattern ambiguity is handled.
  writePattern('mobile-ui-rules', 'title: Mobile UI Rules\ndescription: Haptics and native transitions.');
  writePattern('multi-reviewer-pattern', 'name: "Multi-Reviewer Pattern (router + niche specialists)"\ndescription: Route a diff to specialists.');
  writePattern('sub-agent-iterative-reviewer-pattern', 'name: Sub-Agent with Iterative Reviewer Pattern\ndescription: Loop a reviewer.');
  // A pattern whose frontmatter block scalar broke, leaving the literal `>-`.
  writePattern('cli-derived-action-rows', 'name: >-\ndescription: Rows derived from the CLI.', '# CLI-Derived Action Rows\n');
});

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
});

describe('folding — one word, one key, across alphabets', () => {
  it('lines up the Turkish verb, the possessive, and the ascii filename', () => {
    // The exact three-way split that made the feature impossible before:
    // "özetle", the ascii filename's "ozeti", and the title's "özeti" each
    // produced a different stem. They need not fold to a BYTE-identical key —
    // stripping short vowels was what broke `state` vs `status` — they need to
    // ALIGN, which is the guarantee the matcher actually rests on.
    const forms = ['özetle', 'özeti', 'ozeti', 'özet', 'ozet'].map(foldKey);
    for (const a of forms) {
      for (const b of forms) expect(keysAlign(a, b), `${a} ~ ${b}`).toBe(true);
    }
  });

  it('folds diacritics so a Turkish title and its ascii slug produce the same key', () => {
    expect(foldKey('çakışma')).toBe(foldKey('cakisma'));
    expect(foldKey('öğretmen')).toBe(foldKey('ogretmen'));
  });

  it('strips stacked Turkish suffixes (agglutination needs more than one hop)', () => {
    expect(foldKey('raporlarından')).toBe('rapor');
  });

  it('drops words that name the CATEGORY rather than the pattern', () => {
    // Otherwise every pattern in the vault fires whenever the user says "pattern".
    const keys = foldKeys('pattern kuralları best practice');
    expect(keys.has('pattern')).toBe(false);
    expect(keys.has('kural')).toBe(false);
  });

  it('refuses strips that would leave a stub', () => {
    // One suffix may come off `title` (and does, on both sides, harmlessly) —
    // but the base is never eroded past four characters into `tit`, which is
    // short enough to collide with unrelated words.
    expect(foldKey('title').length).toBeGreaterThanOrEqual(4);
    expect(foldKey('data')).toBe('data');
    expect(foldKey('test')).toBe('test');
  });
});

describe('display names — derived, never written back', () => {
  it('prefers the document H1 over a frontmatter name that just repeats the filename', () => {
    expect(displayName(
      { name: 'plan-ozeti-mehmete-nasil-anlatilir' },
      'plan-ozeti-mehmete-nasil-anlatilir',
      "# Plan özeti Mehmet'e nasıl anlatılır\n",
    )).toBe("Plan özeti Mehmet'e nasıl anlatılır");
  });

  it('survives a broken block scalar leaking `>-` as the name', () => {
    expect(displayName({ name: '>-' }, 'cli-derived-action-rows', '# CLI-Derived Action Rows\n'))
      .toBe('CLI-Derived Action Rows');
  });

  it('drops the parenthetical tail that makes a name unusable as a menu label', () => {
    expect(displayName({ name: 'Multi-Reviewer Pattern (router + niche specialists)' }, 'x'))
      .toBe('Multi-Reviewer Pattern');
  });

  it('accepts `title:` where a vault used it instead of `name:`', () => {
    expect(displayName({ title: 'Mobile UI Rules' }, 'mobile-ui-rules')).toBe('Mobile UI Rules');
  });

  it('falls back to the slug when there is nothing else', () => {
    expect(displayName({}, 'byte-surgical-section-editing')).toBe('Byte surgical section editing');
  });
});

describe('slash names', () => {
  it('prefixes with `pattern-` so typing /pattern browses them all', () => {
    expect(slashNameFor('feature-integration-pattern').startsWith('pattern-')).toBe(true);
  });

  it('drops the trailing category word rather than saying pattern twice', () => {
    expect(slashNameFor('feature-integration-pattern')).toBe('pattern-feature-integration');
  });

  it('keeps the name short enough to read in a menu', () => {
    expect(slashNameFor('presentation-field-must-not-double-as-safety-predicate').length)
      .toBeLessThanOrEqual('pattern-'.length + 30);
  });

  it('contains the word a user would type, so substring search finds it', () => {
    // The composer matches by prefix AND substring, so `/ozet` must reach this.
    expect(slashNameFor('plan-ozeti-mehmete-nasil-anlatilir')).toContain('ozet');
  });
});

describe('trigger derivation — automatic, no authoring required', () => {
  it('derives triggers for a pattern that declares none', () => {
    const p = loadPatterns(ROOT).find((x) => x.slug === 'plan-ozeti-mehmete-nasil-anlatilir')!;
    expect(p.authored).toBe(false);
    expect([...p.keys].some((k) => keysAlign(k, foldKey('özetle')))).toBe(true);
    expect([...p.keys]).toContain('plan');
  });

  it('takes the description as CORROBORATION only, never as identity', () => {
    const p = loadPatterns(ROOT).find((x) => x.slug === 'mobile-ui-rules')!;
    expect([...p.keys]).not.toContain('haptic');
    expect([...p.context]).toContain('haptic');
  });

  it('honours an authored `triggers:` list as an ADDITION to what it derived', () => {
    writePattern('tenant-seam', 'name: Tenant Seam\ntriggers: [kurum, çok kiracılı]\ndescription: x');
    const p = loadPatterns(ROOT).find((x) => x.slug === 'tenant-seam')!;
    expect(p.authored).toBe(true);
    expect([...p.keys]).toContain('kurum');
    expect([...p.keys]).toContain('tenant'); // still derived from the name
    rmSync(join(ROOT, 'knowledge', 'patterns', 'tenant-seam.md'));
  });
});

describe('matching — the regression this feature exists for', () => {
  it('fires the plan-summary pattern on a bare "özetle"', () => {
    // The literal user report: "özetle diyorum, summary patternim var, ama olmuyor".
    const hits = matchPatterns('özetle', loadPatterns(ROOT));
    expect(hits.map((h) => h.pattern.slug)).toContain('plan-ozeti-mehmete-nasil-anlatilir');
  });

  it('fires it from English too, without an English trigger being authored', () => {
    const hits = matchPatterns('summarize the plan for me', loadPatterns(ROOT));
    expect(hits.map((h) => h.pattern.slug)).toContain('plan-ozeti-mehmete-nasil-anlatilir');
  });

  it('tolerates a one-letter stemming gap between the pattern and the prompt', () => {
    // `mobile` folds to `mobi`, the Turkish `mobil` a user types does not.
    const hits = matchPatterns('mobil ekranda ne yapmalıyım', loadPatterns(ROOT));
    expect(hits.map((h) => h.pattern.slug)).toContain('mobile-ui-rules');
  });

  it('stays SILENT on a long technical dump that merely CONTAINS a pattern word', () => {
    // The production failure that this rule exists for: the first shipped
    // version fired three patterns off a routine background-task notification,
    // because "test", "code" and "file" were each unique among 42 filenames.
    // Evidence has to scale with the size of the haystack.
    const dump = `Background command "Run the full unit test suite" completed with exit code 0.
      The auto-capture fires on turns whose content matches task-notification XML, agent-resume
      JSON, and skill-loader headers. A backgrounded Bash command vanishes from the Chat view.
      Every fan-out this project performs is a backgrounded claude -p, which the CLI reports as
      local_bash and is therefore indistinguishable at the frame level from npm test; the whole
      fleet landed here as anonymous rows while the sub-agent card the user watches sat empty.
      The plan is to read the file, check the code, and report the state of each mobile review.`;
    expect(matchPatterns(dump, loadPatterns(ROOT))).toHaveLength(0);
  });

  it('does not confuse `state` with `status` by over-stripping either', () => {
    // Both folded to `stat` once, so "git status bak" fired a pattern about
    // per-session state files.
    expect(foldKey('state')).not.toBe(foldKey('status'));
  });

  it('stays SILENT on prompts that name no pattern', () => {
    // A gate that fires wrongly is a gate the agent learns to ignore, so the
    // matcher is tuned for zero false positives rather than maximum recall.
    const docs = loadPatterns(ROOT);
    for (const noise of [
      'bugün hava nasıl',
      'merhaba nasılsın',
      'commit at ve pushla',
      'bu dosyayı oku',
      'npm install çalıştır',
      'iyi akşamlar',
    ]) {
      expect(matchPatterns(noise, docs), noise).toHaveLength(0);
    }
  });

  it('does not fire every pattern when the user says the word "pattern"', () => {
    expect(matchPatterns('bu pattern konusunu konuşalım', loadPatterns(ROOT))).toHaveLength(0);
  });

  it('needs corroboration for a key several patterns share', () => {
    const docs = loadPatterns(ROOT);
    // `reviewer` belongs to two patterns and is not decisive on its own here,
    // but with a second shared key the intended one wins.
    const both = matchPatterns('multi reviewer', docs);
    expect(both[0]?.pattern.slug).toBe('multi-reviewer-pattern');
  });

  it('never floods the prompt with more than a handful', () => {
    const docs = loadPatterns(ROOT);
    expect(matchPatterns('plan reviewer mobile ui özet', docs).length)
      .toBeLessThanOrEqual(MAX_PATTERN_MATCHES);
  });

  it('is silent on a vault with no patterns at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dc-nopat-'));
    expect(loadPatterns(join(empty, '_dream_context'))).toHaveLength(0);
    expect(matchPatterns('özetle', [])).toHaveLength(0);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('"/" shims', () => {
  it('writes one command per pattern', () => {
    const result = syncPatternShims(PROJECT, ROOT);
    expect(result.written.length).toBe(loadPatterns(ROOT).length);
    expect(existsSync(join(PROJECT, '.claude', 'commands', 'pattern-plan-ozeti-mehmete-nasil.md'))).toBe(true);
  });

  it('points the command at the live file instead of copying the pattern into it', () => {
    // Drift-free by construction: the shim carries a path and a one-line
    // description for the menu, never the pattern's prose, so editing a pattern
    // never leaves a stale copy behind in `.claude/`.
    writePattern('drift-check', 'name: Drift Check\ndescription: A one-line summary.', '# Drift Check\n\nBODY-THAT-MUST-NOT-BE-COPIED\n');
    syncPatternShims(PROJECT, ROOT);
    const body = readFileSync(join(PROJECT, '.claude', 'commands', 'pattern-drift-check.md'), 'utf-8');
    expect(body).toContain('knowledge/patterns/drift-check.md');
    expect(body).not.toContain('BODY-THAT-MUST-NOT-BE-COPIED');
    rmSync(join(ROOT, 'knowledge', 'patterns', 'drift-check.md'));
    syncPatternShims(PROJECT, ROOT);
  });

  it('is idempotent — a second run rewrites nothing', () => {
    syncPatternShims(PROJECT, ROOT);
    expect(syncPatternShims(PROJECT, ROOT).written).toHaveLength(0);
  });

  it('prunes the shim of a pattern that was deleted', () => {
    writePattern('temporary-thing', 'name: Temporary Thing\ndescription: x');
    syncPatternShims(PROJECT, ROOT);
    const shim = join(PROJECT, '.claude', 'commands', 'pattern-temporary-thing.md');
    expect(existsSync(shim)).toBe(true);
    rmSync(join(ROOT, 'knowledge', 'patterns', 'temporary-thing.md'));
    const result = syncPatternShims(PROJECT, ROOT);
    expect(result.removed).toContain('pattern-temporary-thing.md');
    expect(existsSync(shim)).toBe(false);
  });

  it('never deletes a command the user wrote themselves', () => {
    const mine = join(PROJECT, '.claude', 'commands', 'pattern-my-own.md');
    writeFileSync(mine, '---\ndescription: mine\n---\nhand written\n', 'utf-8');
    syncPatternShims(PROJECT, ROOT);
    expect(existsSync(mine)).toBe(true);
    rmSync(mine);
  });
});

describe('injection — the pattern arrives IN the turn, not as a path', () => {
  it('never demotes the top match to a pointer, even on a tiny budget', () => {
    // The single most relevant pattern is exactly what the user asked to stop
    // fetching by hand, so it is exempt from the budget — bounded only by
    // FIRST_MATCH_CEILING_FACTOR, which a real pattern never reaches.
    const hits = matchPatterns('özetle', loadPatterns(ROOT));
    const plan = selectForInjection(hits, 10);
    expect(plan.inline).toHaveLength(1);
    expect(plan.pointers).toHaveLength(0);
  });

  it('injects a normal-sized pattern whole', () => {
    const plan = selectForInjection(matchPatterns('özetle', loadPatterns(ROOT)));
    expect(plan.inline[0].body).toContain('Kalıp');
    expect(plan.inline[0].body).not.toContain('truncated');
  });

  it('strips frontmatter so the turn carries the argument, not the bookkeeping', () => {
    const plan = selectForInjection(matchPatterns('özetle', loadPatterns(ROOT)));
    expect(plan.inline[0].body.startsWith('---')).toBe(false);
    expect(plan.inline[0].body).not.toContain('description:');
  });

  it('degrades the tail to pointers instead of flooding the turn', () => {
    const docs = loadPatterns(ROOT);
    const hits = matchPatterns('plan özeti reviewer mobil', docs);
    if (hits.length < 2) return; // vault too small to exercise the tail
    const plan = selectForInjection(hits, 1);
    expect(plan.inline).toHaveLength(1);
    expect(plan.pointers.length).toBe(hits.length - 1);
  });

  it('falls back to pure pointers when injection is disabled', () => {
    const hits = matchPatterns('özetle', loadPatterns(ROOT));
    const plan = selectForInjection(hits, 0);
    expect(plan.inline).toHaveLength(0);
    expect(plan.pointers).toHaveLength(hits.length);
  });
});

describe('staying in step with the vault, with no command to run', () => {
  it('changes its fingerprint when a pattern is added or removed', () => {
    const before = patternsFingerprint(ROOT);
    writePattern('fingerprint-probe', 'name: Fingerprint Probe\ndescription: x');
    expect(patternsFingerprint(ROOT)).not.toBe(before);
    rmSync(join(ROOT, 'knowledge', 'patterns', 'fingerprint-probe.md'));
    expect(patternsFingerprint(ROOT)).toBe(before);
  });

  it('syncs once, then does nothing until the vault actually changes', () => {
    rmSync(join(ROOT, 'state', '.patterns-shims.json'), { force: true });
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).not.toBeNull();
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).toBeNull();

    writePattern('late-arrival', 'name: Late Arrival\ndescription: x');
    const after = syncPatternShimsIfStale(PROJECT, ROOT);
    expect(after?.written).toContain('pattern-late-arrival.md');

    rmSync(join(ROOT, 'knowledge', 'patterns', 'late-arrival.md'));
    expect(syncPatternShimsIfStale(PROJECT, ROOT)?.removed).toContain('pattern-late-arrival.md');
  });
});

describe('the keep-them-true rule ships in the hook, not only in prose', () => {
  // `knowledge/patterns/hook-delivered-must-not-miss-rules.md` says the
  // load-bearing half of a must-not-miss rule lives in the hook that always
  // fires, and that its text is pinned in code so it cannot drift from the
  // implementation. This is that pin.
  const HOOK_SRC = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'commands', 'hook.ts'), 'utf-8');

  it('tells the agent to update a contradicted pattern before finishing the task', () => {
    expect(HOOK_SRC).toContain('you MUST update');
    expect(HOOK_SRC).toContain('BEFORE you finish this task');
  });

  it('names sleep explicitly as the wrong place for it', () => {
    expect(HOOK_SRC).toContain('Not at the end of the session, not ');
    expect(HOOK_SRC).toContain('in sleep.');
  });

  it('requires the agent to SAY when it judges a correction one-off', () => {
    // Silence is the failure mode this clause exists to close: an agent that
    // quietly decides "that was one-off" is indistinguishable from one that
    // forgot the rule.
    expect(HOOK_SRC).toContain('do not silently skip it');
  });

  it('keeps sleep out of pattern CONTENT', () => {
    const sleepRef = readFileSync(join(__dirname, '..', '..', 'skill', 'references', 'sleep.md'), 'utf-8');
    const sleepAgent = readFileSync(join(__dirname, '..', '..', 'agents', 'sleep-product.md'), 'utf-8');
    expect(sleepRef).toContain('Sleep does NOT fold user corrections into patterns');
    expect(sleepAgent).toContain('Never fold a user correction into a pattern');
  });
});

describe('review findings — regression locks', () => {
  // Every case below was a real defect found by the multi-reviewer pass on
  // f03c001. The two Critical ones were reproduced end-to-end first.

  it('C1: refuses a symlinked pattern instead of printing what it points at', () => {
    // Reproduced before the guard: `knowledge/patterns/x.md ->
    // ../../lab/credentials.json` printed `{"apiKey":"…"}` into a live prompt.
    mkdirSync(join(ROOT, 'lab'), { recursive: true });
    const secret = join(ROOT, 'lab', 'credentials.json');
    writeFileSync(secret, '{"apiKey":"SECRET_VALUE_123"}', 'utf-8');
    const link = join(ROOT, 'knowledge', 'patterns', 'plan-ozeti-leak.md');
    symlinkSync('../../lab/credentials.json', link);

    const { patterns, skipped } = loadPatternsReporting(ROOT);
    expect(patterns.map((p) => p.slug)).not.toContain('plan-ozeti-leak');
    expect(skipped.some((s) => s.file.endsWith('plan-ozeti-leak.md'))).toBe(true);
    // And nothing that DOES load carries the secret.
    const plan = selectForInjection(matchPatterns('plan özeti', patterns));
    for (const { body } of plan.inline) expect(body).not.toContain('SECRET_VALUE_123');

    rmSync(link);
    rmSync(secret);
  });

  it('C1: refuses a pattern reached through a symlinked DIRECTORY', () => {
    // `lstat` on the leaf sees a regular file here — only the realpath
    // containment check catches it.
    const outside = join(PROJECT, 'outside-vault');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'sneaky-thing.md'), '---\nname: Sneaky\n---\n\n# Sneaky\n\nSECRET_VALUE_456\n', 'utf-8');
    const linkedDir = join(ROOT, 'knowledge', 'patterns', 'linked');
    symlinkSync(outside, linkedDir);

    const { patterns } = loadPatternsReporting(ROOT);
    expect(patterns.map((p) => p.slug)).not.toContain('sneaky-thing');

    rmSync(linkedDir);
    rmSync(outside, { recursive: true, force: true });
  });

  it('C1: refuses an oversized pattern rather than reading it on every prompt', () => {
    const big = join(ROOT, 'knowledge', 'patterns', 'enormous-thing.md');
    writeFileSync(big, `---\nname: Enormous Thing\n---\n\n# Enormous Thing\n\n${'x'.repeat(MAX_PATTERN_FILE_BYTES + 1)}`, 'utf-8');
    const { patterns, skipped } = loadPatternsReporting(ROOT);
    expect(patterns.map((p) => p.slug)).not.toContain('enormous-thing');
    expect(skipped.some((s) => s.file.endsWith('enormous-thing.md'))).toBe(true);
    rmSync(big);
  });

  it('C2: injected prose is delimited and labelled as a project document', () => {
    const HOOK_SRC = readFileSync(join(__dirname, '..', '..', 'src', 'cli', 'commands', 'hook.ts'), 'utf-8');
    expect(HOOK_SRC).toContain('BEGIN PROJECT DOCUMENT');
    expect(HOOK_SRC).toContain('END PROJECT DOCUMENT');
    // The line that keeps the feature intact while closing the escalation:
    // engineering guidance is followed, conduct instructions are not.
    expect(HOOK_SRC).toContain('Follow its ENGINEERING ');
    expect(HOOK_SRC).toContain('STOP and report');
  });

  it('M3: truncates an over-ceiling top match instead of injecting it unbounded', () => {
    const huge = join(ROOT, 'knowledge', 'patterns', 'verbose-ozet-thing.md');
    writeFileSync(huge, `---\nname: Verbose Ozet Thing\n---\n\n# Verbose Ozet Thing\n\n${'y'.repeat(5000)}`, 'utf-8');
    const hits = matchPatterns('verbose ozet thing', loadPatterns(ROOT));
    const plan = selectForInjection(hits, 100);
    expect(plan.inline[0].body.length).toBeLessThanOrEqual(100 * FIRST_MATCH_CEILING_FACTOR + 200);
    expect(plan.inline[0].body).toContain('truncated');
    rmSync(huge);
  });

  it('M4: reports a pattern whose frontmatter will not parse, instead of dropping it in silence', () => {
    const broken = join(ROOT, 'knowledge', 'patterns', 'broken-yaml-thing.md');
    writeFileSync(broken, '---\nname: [unclosed\n  bad: : indent\n---\n\n# Broken\n', 'utf-8');
    const { patterns, skipped } = loadPatternsReporting(ROOT);
    const loadedOk = patterns.some((p) => p.slug === 'broken-yaml-thing');
    const reported = skipped.some((s) => s.file.endsWith('broken-yaml-thing.md'));
    // Either it parsed, or it was reported — what must never happen is both
    // "absent from the corpus" and "absent from the skip list".
    expect(loadedOk || reported).toBe(true);
    rmSync(broken);
  });

  it('M5: an existing pattern keeps its "/" name when a colliding neighbour appears', () => {
    const a = 'zzzz-aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-one';
    const b = 'zzzz-aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-two';
    writePattern(a, `name: Collide One\ndescription: x`);
    const before = loadPatterns(ROOT).find((p) => p.slug === a)!.slashName;

    writePattern(b, `name: Collide Two\ndescription: x`);
    const after = loadPatterns(ROOT).find((p) => p.slug === a)!.slashName;
    const other = loadPatterns(ROOT).find((p) => p.slug === b)!.slashName;

    // The guarantee that matters: a "/" name never comes to mean a DIFFERENT
    // pattern. Under the old counter scheme the bare name went to whichever
    // slug sorted first, so adding a neighbour silently repointed an existing
    // command at someone else's prose. Now both colliding patterns take a
    // suffix derived from their own slug — `a` is renamed once, which is
    // visible, but `b` can never inherit the name `a` used to answer to.
    expect(other).not.toBe(before);
    expect(other).not.toBe(after);
    // And the outcome is a pure function of the slug set: recomputing is stable.
    expect(loadPatterns(ROOT).find((p) => p.slug === a)!.slashName).toBe(after);

    rmSync(join(ROOT, 'knowledge', 'patterns', `${a}.md`));
    rmSync(join(ROOT, 'knowledge', 'patterns', `${b}.md`));
  });

  it('M6: notices its own output going missing, not just the patterns changing', () => {
    rmSync(join(ROOT, 'state', '.patterns-shims.json'), { force: true });
    syncPatternShimsIfStale(PROJECT, ROOT);
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).toBeNull();

    // Wipe the generated menu by hand — the patterns themselves did not change.
    rmSync(commandsDir(PROJECT), { recursive: true, force: true });
    const healed = syncPatternShimsIfStale(PROJECT, ROOT);
    expect(healed, 'a wiped commands dir must trigger a re-sync').not.toBeNull();
    expect(healed!.written.length).toBeGreaterThan(0);
  });

  it('M7: does not write the shared cache while another process holds the lock', () => {
    rmSync(join(ROOT, 'state', '.patterns-shims.json'), { force: true });
    const lockPath = join(ROOT, 'state', '.patterns-shims.json.lock');
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf-8');

    // Losing the race is harmless — the loser re-syncs next session — so it
    // must back off rather than write over the holder.
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).toBeNull();
    expect(existsSync(join(ROOT, 'state', '.patterns-shims.json'))).toBe(false);

    rmSync(lockPath, { force: true });
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).not.toBeNull();
  });
});
