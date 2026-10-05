/**
 * The whiteboard agent card is documented where an agent will look for it, and stays so.
 *
 * Feature-integration pattern item 8: a capability the skill does not describe is invisible,
 * so the load-bearing phrases are pinned here and a later edit cannot drop them silently.
 * Text scans only: root vitest cannot import a dashboard `.tsx`, and the docs are prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOARD_AGENT_BOARD_VERBS,
  BOARD_AGENT_READ_VERBS,
  BOARD_AGENT_SELF_VERBS,
} from '../../src/lib/automations/board-scope.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV, APPROVAL_DIFF_FIELDS } from '../../src/lib/automations/types.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf-8');

const WHITEBOARDS_MD = read('skill', 'references', 'whiteboards.md');
const AUTOMATIONS_MD = read('skill', 'references', 'automations.md');
const CLI_REFERENCE_MD = read('skill', 'references', 'cli-reference.md');
const INTEGRATIONS_MD = read('skill', 'references', 'integrations.md');
const SKILL_MD = read('skill', 'SKILL.md');
const README_MD = read('README.md');
const I18N = read('dashboard', 'src', 'context', 'I18nContext.tsx');

describe('skill/references/whiteboards.md: the agent card', () => {
  it('lists `agent` as a widget kind with its add command', () => {
    expect(WHITEBOARDS_MD).toContain('## The ten widget kinds');
    expect(WHITEBOARDS_MD).toContain('`add <slug> agent --ref');
  });

  it('has the Agent cards section, home versus attached', () => {
    expect(WHITEBOARDS_MD).toContain('## Agent cards: an agent that lives on the board');
    expect(WHITEBOARDS_MD).toContain('--whiteboard <board>');
    expect(WHITEBOARDS_MD).toContain('`agents[].home`');
  });

  it('states the scope: own board only, dontAsk, and the fail-closed refusal', () => {
    expect(WHITEBOARDS_MD).toContain('**A home-board agent acts only on its board.**');
    expect(WHITEBOARDS_MD).toContain('--permission-mode dontAsk --setting-sources project');
    expect(WHITEBOARDS_MD).toContain('Could not limit <title> to its board: <reason>');
  });

  it('names every read verb the allowlist grants, so the doc cannot drift from the argv', () => {
    // The doc groups verbs (`lab list|show`); a verb is covered when all its words appear, in
    // order, inside one backticked span.
    for (const verb of BOARD_AGENT_READ_VERBS) {
      const pattern = verb.split(' ').map((w) => `\\b${w}\\b`).join('[^`]*');
      const covered = new RegExp(`\`${pattern}[^\`]*\``).test(WHITEBOARDS_MD);
      expect(covered, `whiteboards.md does not name the read verb "${verb}"`).toBe(true);
    }
    expect(BOARD_AGENT_BOARD_VERBS.length).toBeGreaterThan(0);
    expect(WHITEBOARDS_MD).toContain('`whiteboard add|update|remove|draw|nav add|nav remove|nav move <its board>`');
    expect(BOARD_AGENT_SELF_VERBS).toEqual(['automations post', 'automations learn', 'automations propose']);
    expect(WHITEBOARDS_MD).toContain('`automations post|learn|propose <itself>`');
  });

  it('states the scoped --file rule (scratch or own output folder only) in every doc that names it', () => {
    const RULE = '`whiteboard add|update|draw --file` reads only from the agent\'s scratch folder '
      + '(`$DREAMCONTEXT_AGENT_SCRATCH`) or `_dream_context/automations/output/<self>/`, compared by real path, '
      + 'and refuses any symlink';
    expect(WHITEBOARDS_MD).toContain(RULE);
    expect(AUTOMATIONS_MD).toContain(RULE);
    expect(CLI_REFERENCE_MD).toContain('`add|update|draw --file` reads only from the agent\'s scratch folder');
    for (const [name, doc] of [['whiteboards.md', WHITEBOARDS_MD], ['automations.md', AUTOMATIONS_MD], ['cli-reference.md', CLI_REFERENCE_MD]] as const) {
      expect(doc, `${name} still states the old project-wide --file rule`).not.toMatch(/--file` refuses a file (whose real path is )?outside the project/);
    }
  });

  it('documents drag-to-ask and its reference token', () => {
    expect(WHITEBOARDS_MD).toContain('**Drag to ask.**');
    expect(WHITEBOARDS_MD).toContain('**The card is its own conversation, never the agent\'s thread.**');
    expect(AUTOMATIONS_MD).toContain('**A card is its own conversation, not the thread:**');
    expect(WHITEBOARDS_MD).toContain('`dcref:wb/<board>/<id>`');
  });
});

describe('skill/references/automations.md: the whiteboard field and its approval', () => {
  it('counts the approval-hashed fields as ten, matching APPROVAL_DIFF_FIELDS', () => {
    expect(APPROVAL_DIFF_FIELDS).toHaveLength(10);
    expect(APPROVAL_DIFF_FIELDS[APPROVAL_DIFF_FIELDS.length - 1]).toBe('whiteboard');
    expect(AUTOMATIONS_MD).toContain('across all ten of those fields');
    expect(AUTOMATIONS_MD).not.toMatch(/all nine|those nine fields/);
  });

  it('has the Board agents recipe and the manifest field row', () => {
    expect(AUTOMATIONS_MD).toContain('### Board agents: an agent that lives on one whiteboard');
    expect(AUTOMATIONS_MD).toContain('| `whiteboard` | The agent\'s **home board**');
    expect(AUTOMATIONS_MD).toContain('Every spawn is scoped, never `bypassPermissions`');
  });

  it('says a resume re-checks approval and reply turns carry the pattern', () => {
    expect(AUTOMATIONS_MD).toContain('**A resume also re-checks approval.**');
    expect(AUTOMATIONS_MD).toContain('**A conversation teaches it too.**');
  });
});

describe('skill/references/cli-reference.md: every new verb and flag', () => {
  it('documents create --whiteboard, the agent widget and show --json agents', () => {
    expect(CLI_REFERENCE_MD).toContain('`--whiteboard <board>` (home the agent on that whiteboard');
    expect(CLI_REFERENCE_MD).toContain('`agent` (an automation agent\'s card, `--ref <agent-slug>`)');
    expect(CLI_REFERENCE_MD).toContain('`agents: [{id, slug, title, home, missing}]`');
  });

  it('documents the assistant agent verb', () => {
    expect(CLI_REFERENCE_MD).toContain('| `assistant agent <vault> "<text>" (--board <board> \\| --slug <slug>)` |');
  });

  it('integrations.md lists the assistant agent verb among the gated ones', () => {
    expect(INTEGRATIONS_MD).toContain('dreamcontext assistant agent <vault> "<text>" (--board <b> | --slug <s>)');
    expect(INTEGRATIONS_MD).toContain('`ask` — send, agent, answer and broadcast become PROPOSALS');
  });

  it('documents the three scope env vars and the CLI second layer', () => {
    for (const v of [AGENT_BOARD_ENV, AGENT_SELF_ENV, AGENT_SCRATCH_ENV]) {
      expect(CLI_REFERENCE_MD, `cli-reference.md does not name ${v}`).toContain(`\`${v}\``);
    }
    expect(CLI_REFERENCE_MD).toContain('**While `DREAMCONTEXT_AGENT_BOARD` is set**');
    expect(CLI_REFERENCE_MD).toContain('**While `DREAMCONTEXT_AGENT_SELF` is set**');
  });
});

describe('skill/SKILL.md and README.md: the capability is visible at a glance', () => {
  it('the Whiteboard capability row mentions agent cards', () => {
    const row = SKILL_MD.split('\n').find((l) => l.startsWith('| **Whiteboard** |'));
    expect(row, 'no Whiteboard capability row').toBeDefined();
    expect(row).toContain('agent cards');
  });

  it('README names the agent card and the board-only scope', () => {
    expect(README_MD).toContain('An **agent card** puts an automation agent on the board');
    expect(README_MD).toContain('**A board agent acts only on its board.**');
  });
});

describe('dashboard I18nContext: the agent card speaks English and Turkish', () => {
  const KEYS = [
    'whiteboard.kind.agent',
    'whiteboard.palette.agent',
    'whiteboard.palette.newAgent',
    'whiteboard.palette.noAgents',
    'whiteboard.agent.placeholder',
    'whiteboard.agent.startHint',
    'whiteboard.agent.missing',
    'whiteboard.drop.kind.agent',
    'whiteboard.drop.kind.shape',
    'agents.card.board',
  ];
  const trStart = I18N.indexOf('const TR_PARTIAL');
  const en = I18N.slice(0, trStart);
  const tr = I18N.slice(trStart);

  it('has each key in both the English block and the Turkish partial', () => {
    expect(trStart).toBeGreaterThan(-1);
    for (const k of KEYS) {
      expect(en, `English is missing ${k}`).toContain(`'${k}':`);
      expect(tr, `Turkish is missing ${k}`).toContain(`'${k}':`);
    }
  });

  it('keeps em dashes out of the new copy', () => {
    const re = /'((?:whiteboard\.(?:agent|drop)|whiteboard\.palette\.(?:agent|newAgent|noAgents)|agents\.card\.board)[\w.-]*)':\s*'((?:[^'\\]|\\.)*)'/g;
    let seen = 0;
    for (const m of I18N.matchAll(re)) {
      seen++;
      expect(m[2], `${m[1]} carries an em dash`).not.toContain('—');
    }
    expect(seen).toBeGreaterThan(KEYS.length);
  });
});
