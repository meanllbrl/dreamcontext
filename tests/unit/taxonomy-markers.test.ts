/**
 * Marker tests: verify that required behavior headings / labels exist in the
 * correct files. These are exact-string presence checks — no logic, just guard
 * against accidental deletion of critical behavioral markers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

// ── sleep-product.md markers ─────────────────────────────────────────────────

describe('agents/sleep-product.md markers', () => {
  const content = readFileSync(join(ROOT, 'agents', 'sleep-product.md'), 'utf-8');

  it("has the '### Pass C — Taxonomy maintenance' heading", () => {
    // Pass A and Pass B use ### level; Pass C must be at the same level.
    expect(content).toContain('### Pass C — Taxonomy maintenance');
  });

  it('has a Taxonomy return sub-section in the report block', () => {
    expect(content).toContain('### Taxonomy');
  });

  it('has the B3 taxonomy vocab pointer rewrite', () => {
    // B3 should reference taxonomy vocab
    expect(content).toContain('taxonomy vocab');
  });

  it('Pass C contains the taxonomy alias CLI command', () => {
    // Agents must use CLI to mutate vocabulary, not edit markdown directly.
    expect(content).toContain('taxonomy alias');
  });
});

// ── skill/SKILL.md markers ───────────────────────────────────────────────────

describe('skill/SKILL.md markers', () => {
  const content = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');

  it("has the 'Tag before you create.' operational rule", () => {
    expect(content).toContain('Tag before you create.');
  });

  it('has a pointer to dreamcontext taxonomy vocab command', () => {
    expect(content).toContain('dreamcontext taxonomy vocab');
  });

  // Lab docs went missing from skill/ once already (v0.11.0 shipped the code with
  // zero skill docs and agents misrouted "create insight" to knowledge create).
  // These markers make that failure loud instead of silent.
  it('has the Entity Router section', () => {
    expect(content).toContain('## Entity Router');
  });

  it('has a Lab / Insights capabilities row', () => {
    expect(content).toContain('**Lab / Insights**');
  });

  it('names the lab create command for insights', () => {
    expect(content).toContain('dreamcontext lab create');
  });

  // Theses are a creatable entity with the same failure shape as the v0.11.0
  // Lab incident: no router row → agents shadow-build the capture as knowledge.
  it('has a Proactive learning capabilities row', () => {
    expect(content).toContain('**Proactive learning (Hypotheses)**');
  });

  it('names the theses create command in the Entity Router', () => {
    expect(content).toContain('dreamcontext theses create');
  });

  it('routes thesis capture through the opt-in gate', () => {
    expect(content).toContain('theses enable');
  });

  // A real session routed "insight oluşturalım" (Turkish) to a prose analysis and
  // then designed an external dashboard for what `lab create` already covers.
  // These markers pin the two router rules that prevent that.
  it('declares entity nouns as language-independent reserved words', () => {
    expect(content).toContain('Entity nouns are reserved words — in ANY language.');
  });

  it("has the 'don't rebuild what the brain already has' rule", () => {
    expect(content).toContain("Don't rebuild what the brain already has.");
  });

  // Insights shipped with a create-path router row but no READ-path rule, so
  // agents kept answering metric questions by calling a billing MCP / writing a
  // one-off script while the synced series sat in lab/cache. These markers pin
  // the read ladder on both surfaces it has to appear on.
  it("has the 'Insights before external fetch' operational rule", () => {
    expect(content).toContain('Insights before external fetch');
    expect(content).toContain('dreamcontext lab show <slug>');
  });

  it('routes metric READING through the Entity Router, not just creating', () => {
    expect(content).toContain('The router governs READING too, not only creating.');
  });

  // The rule's first rung (the snapshot Lab section) and the rule itself both
  // depend on something that can be absent when a metric is asked for — the
  // snapshot can be budget-demoted, the skill body may never load. The recall
  // hook's per-hit directive is the rung that always fires, so the rule has to
  // name it or a future session won't know it is authoritative.
  it('points at the recall hook directive as the always-on rung', () => {
    expect(content).toContain('ALREADY TRACKED as an insight');
  });

  // Issue #204: duplicate -N task mirrors from a corrupted sync ledger must
  // route to the repair verb, not a hand-rolled fix or a fresh task recreate.
  it('has the tasks dedup capabilities row', () => {
    expect(content).toContain('**Duplicate task family repair**');
    expect(content).toContain('dreamcontext tasks dedup');
  });

  it('routes duplicate task families to tasks dedup in the litmus tests', () => {
    expect(content).toContain('Duplicate task families / `-N` mirrors');
  });

  // "claude: command not found" while claude IS installed is the single most
  // misdiagnosed setup failure (it installs to ~/.local/bin, off every default
  // PATH). Without this pointer an agent concludes "not installed" and walks the
  // user through a reinstall that changes nothing.
  it('routes a missing-on-PATH claude to Fix PATH instead of a reinstall', () => {
    expect(content).toContain('claude: command not found');
    expect(content).toContain('Fix PATH');
  });
});

// ── skill/references lab markers ─────────────────────────────────────────────

describe('skill/references lab doc markers', () => {
  it('cli-reference.md documents the lab verbs', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(content).toContain('lab sync');
    expect(content).toContain('lab credentials set');
  });

  it('tasks-and-features.md has the insight-capture protocol', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(content).toContain('Insight capture (in-session — ASK, never auto-create)');
  });

  it('tasks-and-features.md leads the read ladder with lab show, not an external fetch', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(content).toContain('How agents READ it');
    expect(content).toContain('never fetches');
    expect(content).toContain('a raw API call, or a hand-written script is the LAST resort');
  });

  it('documents the funnel-set payload contract (render: funnel)', () => {
    const tf = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(tf).toContain('funnel-set/v1');
    expect(tf).toContain('Funnel insights (`render: funnel`');
    const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(cli).toContain('--render funnel');
    const skill = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('Funnel analytics');
    // Entity Router: funnel phrases must route to lab create --render funnel,
    // never to a hand-built dashboard/board (the v0.11.0 shadow-build lesson).
    expect(skill).toContain('which funnel is underperforming');
    expect(skill).toContain('Funnel analysis is an insight too');
  });

  // The breakdown contract + render decision guidance shipped with the code in
  // the SAME change (the 2026-07-06 lesson: skill docs lagging the code is how
  // agents kept smuggling dimensions into series names and shipping `raw`).
  it('documents the matrix/v1 payload contract (render: breakdown)', () => {
    const tf = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(tf).toContain('matrix/v1');
    expect(tf).toContain('Breakdown insights (`render: breakdown`');
    expect(tf).toContain('Never bake dimension values into series names');
    expect(tf).toContain('the history trail IS the time axis');
    const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(cli).toContain('--render breakdown');
  });

  it('cli-reference.md carries the render DECISION TABLE with raw as the last resort', () => {
    const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(cli).toContain('Render DECISION TABLE');
    expect(cli).toContain('treat `raw` as the LAST RESORT');
    expect(cli).toContain('NEVER dimension values baked into series names');
  });

  it('documents the html/v1 hybrid: data mandatory, kit classes, typed renders first', () => {
    const tf = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(tf).toContain('HTML card bodies (`html/v1` hybrid');
    expect(tf).toContain('`data` is MANDATORY');
    expect(tf).toContain('lab-html-kit.css');
    expect(tf).toContain('sandbox="allow-scripts"');
    const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(cli).toContain('html/v1');
    expect(cli).toContain("don't write your own CSS");
  });

  it('documents reports: the entity-router row, the CLI verbs, and date honesty', () => {
    const skill = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('**Report** — `lab/reports/<slug>.md`');
    expect(skill).toContain('thirteen distinct entity types');
    const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');
    expect(cli).toContain('lab report create');
    expect(cli).toContain('lab report show');
    const tf = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(tf).toContain('Reports (My Reports');
    expect(tf).toContain('OWNS NO DATA');
    expect(tf).toContain('never an interpolation');
  });
});

// ── skill/references/knowledge-and-recall.md markers ─────────────────────────
// The taxonomy depth lives in the knowledge-and-recall reference (progressive
// disclosure); the always-loaded SKILL.md names the capability + points here.

describe('skill/references/knowledge-and-recall.md markers', () => {
  const content = readFileSync(
    join(ROOT, 'skill', 'references', 'knowledge-and-recall.md'),
    'utf-8',
  );

  it('has a pointer to core/taxonomy.json', () => {
    expect(content).toContain('core/taxonomy.json');
  });

  it('documents the taxonomy vocab + alias commands', () => {
    expect(content).toContain('taxonomy vocab');
    expect(content).toContain('taxonomy alias');
  });
});

// ── brain-sync.md markers ────────────────────────────────────────────────────
// Brain-sync docs lagged the code once: full-repo mode + cross-OS setup shipped
// with zero skill coverage, so an agent could neither explain nor guide GitHub
// sync across machines. These markers make a silent doc regression loud.

describe('skill/references/brain-sync.md markers', () => {
  const content = readFileSync(
    join(ROOT, 'skill', 'references', 'brain-sync.md'),
    'utf-8',
  );

  it('documents the two sync modes (full-repo / in-tree)', () => {
    expect(content).toContain('## The two sync modes');
    expect(content).toContain('full-repo');
    expect(content).toContain('in-tree');
    // separate mode was removed — it must not creep back into the doc.
    expect(content).not.toContain('brain init');
    expect(content).not.toContain('brain platform');
  });

  it('has the cross-machine / cross-OS setup section', () => {
    expect(content).toContain('## Cross-machine / cross-OS setup');
    expect(content).toContain('core.autocrlf false'); // Windows CRLF gotcha
    expect(content).toContain('enclosing-repo trap'); // the git-root footgun
  });

  it('documents token resolution + that gh/credential helpers are NOT used', () => {
    expect(content).toContain('resolveBrainSyncToken');
    expect(content).toContain('config github-token');
  });

  it('has the silent-failure troubleshooting playbook', () => {
    expect(content).toContain('When sync is');
    expect(content).toContain('brain sync --push-only');
  });
});

// ── skill/references tasks dedup markers (#204) ──────────────────────────────
// Duplicate task families from a corrupted/conflicted sync ledger produced 220
// duplicate files out of 425 for one reporter. These markers pin the repair
// verb's documentation so it doesn't silently drop out of the skill docs.

describe('skill/references/integrations.md tasks dedup markers', () => {
  const content = readFileSync(join(ROOT, 'skill', 'references', 'integrations.md'), 'utf-8');

  it('documents the tasks dedup command', () => {
    expect(content).toContain('dreamcontext tasks dedup');
  });

  it('documents the --dry-run-first workflow', () => {
    expect(content).toContain('--dry-run');
  });

  it('documents the --yes requirement for the mutating run', () => {
    expect(content).toContain('--yes');
  });

  it('states the LOCAL-ONLY guarantee (never touches the remote)', () => {
    expect(content).toContain('LOCAL-ONLY guarantee');
  });
});

describe('skill/references/cli-reference.md tasks dedup markers', () => {
  const content = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');

  it('has a tasks dedup row', () => {
    expect(content).toContain('`tasks dedup`');
    expect(content).toContain('LOCAL-ONLY');
  });
});

describe('skill/SKILL.md brain-sync routing', () => {
  const content = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
  it('routes the shared-brain capability to brain-sync.md', () => {
    expect(content).toContain('references/brain-sync.md');
  });
});

describe('skill/references/sleep.md brain-sync step', () => {
  const content = readFileSync(join(ROOT, 'skill', 'references', 'sleep.md'), 'utf-8');
  it('documents that sleep done runs brain sync', () => {
    expect(content).toContain('Brain sync also fires here');
  });
});

// ── skill/references agent-surface prerequisite markers ──────────────────────

describe('skill/references integrations.md — claude PATH prerequisite', () => {
  const content = readFileSync(join(ROOT, 'skill', 'references', 'integrations.md'), 'utf-8');

  // The full protocol behind SKILL.md's pointer: the agent must be able to name
  // the capability flag and the exact install target, not just "there's a button".
  it('documents the capabilities flag and the one-click fix target', () => {
    expect(content).toContain('claudePathBroken');
    expect(content).toContain("target:'claude-path'");
  });

  it('names the install directory that is on no default PATH', () => {
    expect(content).toContain('~/.local/bin');
  });
});

// ── people-first (0.23.0) markers ────────────────────────────────────────────
// 0.23.0 replaced `core/1.user.md` with one constitution per person. This is the
// v0.11.0 Lab failure shape applied to identity: docs that still teach the old
// model route an agent to a file that no longer exists and to a `config people`
// roster write that now refuses. These markers pin the frozen surface — the CLI
// verbs, the router row, the resolution ladder, and the two caveats that are
// only true because nobody built the alternative (no rm tombstone, and a legacy
// branch that dies in 0.24.0).

describe('people-first docs markers', () => {
  const skill = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
  const cli = readFileSync(join(ROOT, 'skill', 'references', 'cli-reference.md'), 'utf-8');

  it('SKILL.md has the People capabilities row', () => {
    expect(skill).toContain('**People (constitutions + roster)**');
    expect(skill).toContain('people/people.json');
  });

  // A person is a CREATABLE entity now — without a router row, "add a teammate"
  // shadow-routes to a knowledge file about that teammate.
  it('SKILL.md has a Person row in the Entity Router', () => {
    expect(skill).toContain('**Person** — `people/<slug>.md`');
    expect(skill).toContain('dreamcontext people add "<Name>" --email <address>');
    expect(skill).toContain('dreamcontext people whoami');
  });

  it('SKILL.md lists person among the reserved entity nouns', () => {
    expect(skill).toContain('automation, release, person');
  });

  // The frozen snapshot headers — an agent that cannot name them cannot explain
  // why no constitution loaded.
  it('SKILL.md names the active-person snapshot headers verbatim', () => {
    expect(skill).toContain('## Person (Active — UNRESOLVED)');
    expect(skill).toContain('Other People (this vault)');
  });

  it('cli-reference.md documents every people verb', () => {
    for (const verb of [
      '`people list`',
      '`people add <name>`',
      '`people show [slug]`',
      '`people whoami`',
      '`people rm <slug>`',
    ]) {
      expect(cli).toContain(verb);
    }
  });

  it('cli-reference.md documents DREAMCONTEXT_PERSON and the 5-rung ladder', () => {
    expect(cli).toContain('DREAMCONTEXT_PERSON');
    expect(cli).toContain('Active-person resolution — the 5-rung ladder');
    expect(cli).toContain('Invariant P');
  });

  // D7: `config people` is a redirect that WRITES NOTHING. Documenting it as an
  // alias would send scripts on writing a roster key that no longer exists.
  it('cli-reference.md carries the config people redirect, not an alias', () => {
    expect(cli).toContain('[Moved in 0.23.0]');
    expect(cli).toContain('redirect, not an alias');
  });

  // D21 (no rm tombstone) and D22 (the legacy branch's removal version).
  it('cli-reference.md states the rm-resurrection caveat and the 0.24.0 sunset', () => {
    expect(cli).toContain('resurrect them on the next brain sync');
    expect(cli).toContain('SUNSET: remove in 0.24.0');
  });

  // D13: person files are constitutions, not corpus. Indexing them would invite
  // the agent to apply someone else's preferences to your session.
  it('knowledge-and-recall.md states person constitutions are not recall-indexed', () => {
    const content = readFileSync(
      join(ROOT, 'skill', 'references', 'knowledge-and-recall.md'),
      'utf-8',
    );
    expect(content).toContain('Person constitutions are NOT knowledge and are NOT recall-indexed');
  });

  it('tasks-and-features.md points the roster at people.json', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'tasks-and-features.md'), 'utf-8');
    expect(content).toContain('_dream_context/people/people.json');
    expect(content).toContain('`--person` defaults to the active person');
  });

  it('troubleshooting.md has both people-first symptoms', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'troubleshooting.md'), 'utf-8');
    expect(content).toContain('## Person (Active — UNRESOLVED)');
    expect(content).toContain('inbox/1.user-residue.md');
    expect(content).toContain('NOTHING IS DISCARDED');
  });

  it('sleep.md gives sleep-state the people layer', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'sleep.md'), 'utf-8');
    expect(content).toContain('`people/people.json` + `people/*.md`');
  });

  it('brain-sync.md documents the people.json union merge and the prose lane', () => {
    const content = readFileSync(join(ROOT, 'skill', 'references', 'brain-sync.md'), 'utf-8');
    expect(content).toContain('key UNION');
    expect(content).toContain("`'other'` prose lane");
  });
});
