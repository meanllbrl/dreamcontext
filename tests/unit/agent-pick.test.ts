import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GAP_SURFACE, TOOL_GAPS, agentNotPickedMessage, agentsPickPath, computeGaps, derivePick, ensurePickedAgents,
  gapRows, gapsOnSurface, jobAgentPicked, needsAgentSentence, pickedAgents, pickedGapList, setPickedAgents,
  type ParityDoc,
} from '../../src/lib/agent-pick.js';

/** Plan npmsiz-beta C16 (the pick record) and C17 (gaps computed from docs/tool-parity.json). */

const PARITY = JSON.parse(readFileSync(join(__dirname, '..', '..', 'docs', 'tool-parity.json'), 'utf-8')) as ParityDoc;

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-pick-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const writeRaw = (raw: string) => {
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(agentsPickPath(home), raw);
};

describe('C16 pick record', () => {
  it('one writer: writes, reads back in a fixed order, leaves no temp file', () => {
    expect(setPickedAgents(['codex', 'claude'], home)).toEqual(['claude', 'codex']);
    expect(pickedAgents(home)).toEqual(['claude', 'codex']);
    expect(JSON.parse(readFileSync(agentsPickPath(home), 'utf-8'))).toEqual({ picked: ['claude', 'codex'] });
    expect(readdirSync(join(home, '.dreamcontext')).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses an empty pick, an unknown agent and a repeat, and changes nothing', () => {
    setPickedAgents(['codex'], home);
    for (const bad of [[], ['gemini'], ['codex', 'codex'], [1], ['claude', '']]) {
      expect(() => setPickedAgents(bad, home)).toThrow();
    }
    expect(pickedAgents(home)).toEqual(['codex']);
  });

  it('refuses a symlinked ~/.dreamcontext', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-pick-x-'));
    try {
      symlinkSync(elsewhere, join(home, '.dreamcontext'));
      expect(() => setPickedAgents(['claude'], home)).toThrow(/not a plain folder/);
      expect(existsSync(join(elsewhere, 'agents.json'))).toBe(false);
      expect(pickedAgents(home)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('malformed, extra-key, empty and unknown records read as absent, never as nothing picked', () => {
    expect(pickedAgents(home)).toBeNull();
    for (const raw of ['{bad', '[]', '{"picked":[]}', '{"picked":["gemini"]}', '{"picked":["claude"],"x":1}', '{"picked":"claude"}']) {
      writeRaw(raw);
      expect(pickedAgents(home)).toBeNull();
    }
  });

  it('no record: an existing user is derived once from what is signed in, never sent back through setup', () => {
    expect(derivePick({ claude: true })).toEqual(['claude']);
    expect(derivePick({ claude: true, codex: true, antigravity: false })).toEqual(['claude', 'codex']);
    expect(ensurePickedAgents({ claude: true }, home)).toEqual({ picked: ['claude'], derived: true });
    // Written once: a later sign-in does not change the record.
    expect(ensurePickedAgents({ claude: true, codex: true }, home)).toEqual({ picked: ['claude'], derived: false });
  });

  it('a malformed record goes through the derive path, never refusing every job', () => {
    writeRaw('{bad');
    expect(ensurePickedAgents({ claude: true }, home)).toEqual({ picked: ['claude'], derived: true });
  });

  it('a new user with nothing signed in gets no record', () => {
    expect(ensurePickedAgents({}, home)).toEqual({ picked: null, derived: false });
    expect(existsSync(agentsPickPath(home))).toBe(false);
  });
});

describe('C17 computed gaps', () => {
  const fixture: ParityDoc = {
    features: [
      { name: 'Chat', claude: 'works', codex: 'works' },
      { name: 'Super Agent', claude: 'works', codex: 'Claude only' },
      { name: 'Brand new thing', claude: 'works', codex: 'Claude only' },
    ],
    capabilities: {
      rows: [
        { ids: ['mode:basic'], kind: 'mode', what: 'Basic', codex: { state: 'works' }, antigravity: { state: 'works' } },
        { ids: ['mode:super'], kind: 'mode', what: 'Super', codex: { state: 'claude-only' }, antigravity: { state: 'claude-only' } },
        { ids: ['control:x', 'control:y'], kind: 'control', what: 'X', codex: { state: 'built' }, antigravity: { state: 'impossible' } },
        { ids: ['headless:z'], kind: 'headless', what: 'Z', codex: { state: 'missing' }, antigravity: { state: 'partly' } },
        { ids: ['hook:h'], kind: 'hook', what: 'H', codex: { state: 'missing' }, antigravity: { state: 'missing' } },
      ],
    },
  };

  it('follows the rule on fixture rows, and a new gap row appears with no code change', () => {
    const g = computeGaps(fixture);
    expect(g.claude).toEqual([]);
    expect(g.codex.map((x) => x.row)).toEqual(['feature:Super Agent', 'feature:Brand new thing', 'mode:super', 'headless:z']);
    expect(g.antigravity.map((x) => x.row)).toEqual(['mode:super', 'control:x']);
    // A multi-id row is keyed by its first id; a hook row never qualifies.
    expect(gapRows(fixture)).not.toContain('control:y');
    expect(gapRows(fixture)).not.toContain('hook:h');
    // Claude counts as working on every capability row; feature rows have no Antigravity column.
    expect(g.antigravity.find((x) => x.row === 'control:x')!.worksOn).toEqual(['claude', 'codex']);
    expect(g.codex.find((x) => x.row === 'headless:z')!.worksOn).toEqual(['claude', 'antigravity']);
    expect(g.codex.find((x) => x.row === 'feature:Super Agent')!.worksOn).toEqual(['claude']);
  });

  it('the shipped file: Codex and Antigravity have their computed rows (10 each at base)', () => {
    expect(TOOL_GAPS.claude).toEqual([]);
    expect(TOOL_GAPS.codex.map((g) => g.row).sort()).toEqual([
      'control:mcp_authenticate', 'control:rewind_conversation', 'control:stop_task',
      'feature:AI Team as chat sub-agents', 'feature:Super Agent',
      'headless:board-agent', 'headless:builder', 'headless:task-step', 'mode:assistant', 'mode:super',
    ]);
    expect(TOOL_GAPS.antigravity.map((g) => g.row).sort()).toEqual([
      'control:mcp_authenticate', 'control:rewind_conversation', 'control:stop_task',
      'headless:ask-write', 'headless:board-agent', 'headless:builder', 'headless:peer', 'headless:task-step',
      'mode:assistant', 'mode:super',
    ]);
  });

  it('GAP_SURFACE maps every gap row of the shipped file', () => {
    const unmapped = gapRows(PARITY).filter((row) => !(row in GAP_SURFACE));
    expect(unmapped).toEqual([]);
  });

  it('the coverage check fails for a qualifying row with no entry', () => {
    const extra: ParityDoc = {
      features: PARITY.features,
      capabilities: { rows: [...PARITY.capabilities.rows, { ids: ['mode:new'], kind: 'mode', what: 'New', codex: { state: 'missing' }, antigravity: { state: 'works' } }] },
    };
    expect(gapRows(extra).filter((row) => !(row in GAP_SURFACE))).toEqual(['mode:new']);
  });

  it('a surface shows a gap only when no picked agent runs it', () => {
    expect(gapsOnSurface('super-tab', ['codex']).map((g) => g.row).sort()).toEqual(['feature:Super Agent', 'mode:super']);
    expect(gapsOnSurface('super-tab', ['codex', 'claude'])).toEqual([]);
    // Codex runs a peer ask; an Antigravity + Codex pick has no settings-only peer gap.
    expect(gapsOnSurface('settings-only', ['antigravity', 'codex']).map((g) => g.row)).toEqual(['headless:builder']);
    expect(gapsOnSurface('board', ['claude'])).toEqual([]);
  });

  it('Settings → Tools lists exactly the computed gaps of each picked agent', () => {
    expect(pickedGapList(['claude'])).toEqual([]);
    expect(pickedGapList(['codex']).map((g) => g.row)).toEqual(TOOL_GAPS.codex.map((g) => g.row));
    expect(pickedGapList(['antigravity']).length).toBe(10);
  });
});

describe('C17 sentence and the job refusal', () => {
  it('names the agents that work, in both languages, with no command', () => {
    expect(needsAgentSentence(['claude'], 'tr')).toBe('Bu özellik şimdilik Claude Code ister.');
    expect(needsAgentSentence(['codex', 'claude'], 'tr')).toBe('Bu özellik şimdilik Claude Code veya Codex ister.');
    expect(needsAgentSentence(['claude'], 'en')).toBe('This feature needs Claude Code for now.');
    expect(needsAgentSentence(['claude', 'codex', 'antigravity'], 'en')).toBe('This feature needs Claude Code, Codex or Antigravity for now.');
    for (const lang of ['en', 'tr'] as const) {
      for (const s of [needsAgentSentence(['claude'], lang), agentNotPickedMessage('claude', lang)]) {
        expect(s).not.toMatch(/dreamcontext |`|—/);
      }
    }
  });

  it('deny-only: an absent tool is Claude; no pick record never refuses; the pick never widens', () => {
    expect(jobAgentPicked(null, ['codex'])).toBe(false);
    expect(jobAgentPicked(undefined, ['claude'])).toBe(true);
    expect(jobAgentPicked('codex', ['codex'])).toBe(true);
    expect(jobAgentPicked('codex', ['claude'])).toBe(false);
    expect(jobAgentPicked(null, null)).toBe(true);
    expect(jobAgentPicked('codex', null)).toBe(true);
  });
});
