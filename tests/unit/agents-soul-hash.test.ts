/**
 * The agent soul in the approval hash (plan D3, proofs P1, P3, P4, P5).
 *
 * The soul is appended LAST and OMITTED when empty, so every manifest that exists
 * today hashes byte-identically to how it hashed before the field existed: an
 * upgrade re-blocks nobody. P1 pins that with golden literals computed from the
 * code BEFORE the soul was added to `canonicalApprovalPayload`.
 */
import { describe, it, expect } from 'vitest';
import {
  approvalDiff,
  approvalFields,
  canonicalApprovalPayload,
  manifestHash,
  renderApprovalReview,
} from '../../src/lib/automations/registry.js';
import { APPROVAL_DIFF_FIELDS, type AutomationManifest, type FlowGraph } from '../../src/lib/automations/types.js';
import { composeRun, legacyPair } from '../../src/lib/agents/compose.js';

/** Every required field stated: nothing typechecks this literal (tests are outside `src`). */
function legacy(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    slug: 'eod-digest',
    id: 'auto_test1234',
    title: 'End of day digest',
    mode: 'sched',
    enabled: true,
    schedule: { slots: [{ kind: 'weekly', days: 'daily', at: '18:00' }] },
    scheduleError: null,
    model: null,
    effort: null,
    timeoutMinutes: 15,
    catchupHours: 6,
    outputDir: null,
    shared: false,
    notify: true,
    learning: false,
    review: 'off',
    flow: null,
    whiteboard: null,
    pattern: '',
    prompt: 'Summarize what happened today.\n\nKeep it to five lines.',
    outputInstructions: '',
    job: '',
    runKind: 'automation',
    agent: 'eod-digest',
    agentTitle: 'End of day digest',
    bindings: [],
    legacyKey: false,
    path: '/tmp/whatever/_dream_context/automations/eod-digest.md',
    body: '## Prompt\n\nSummarize what happened today.\n',
    ...overrides,
  } as AutomationManifest;
}

const FLOW: FlowGraph = {
  version: 'automation-flow/v1',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Daily 18:00' },
    { id: 'agent', kind: 'agent', config: { model: 'opus' } },
    { id: 'gate', kind: 'hitl', label: 'Check with me' },
  ],
  edges: [
    { from: 'trigger', to: 'agent' },
    { from: 'agent', to: 'gate', label: 'draft' },
  ],
};

/** The six P1 fixtures. Built from literals only, so the hash is a pure function of this file. */
function fixtures(): Record<string, AutomationManifest> {
  const legacySched = legacy();
  const legacyCall = legacy({
    slug: 'helper',
    mode: 'call',
    schedule: null,
    outputDir: 'reports/adhoc',
    outputInstructions: 'Bullets only.',
    timeoutMinutes: 45,
    review: 'output',
    model: 'sonnet',
    effort: 'high',
    learning: true,
  });
  const legacyFlow = legacy({ slug: 'flowed', flow: FLOW, review: 'agent' });
  const splitAgentOnly = composeRun(legacyPair(legacy({ slug: 'solo', mode: 'call', schedule: null, model: 'opus' })).agent, null);
  const pair = legacyPair(legacy({ slug: 'researcher', model: 'opus', effort: 'medium' }));
  const splitPairWithJob = composeRun(pair.agent, { ...pair.job!, slug: 'morning-digest', title: 'Morning digest', job: 'Write the morning digest.' });
  const homeBoard = composeRun(legacyPair(legacy({ slug: 'board-pilot', mode: 'call', schedule: null, whiteboard: 'northwind-ops' })).agent, null);
  return {
    'legacy sched': legacySched,
    'legacy call with call settings': legacyCall,
    'legacy with flow': legacyFlow,
    'split agent with no automation': splitAgentOnly,
    'split pair with job': splitPairWithJob,
    'home-board agent': homeBoard,
  };
}

/**
 * Generated with the code as it stood BEFORE `soul` existed (a throwaway run of
 * `manifestHash` over `fixtures()`, pasted here). Never regenerate them from the
 * current code: their whole value is that they came from the old one.
 */
const GOLDEN: Record<string, string> = {
  'legacy sched': 'c50582d17829ac474b0d4d9a2d196361daff7fc48ea8dce5e670882454da4fcb',
  'legacy call with call settings': '4da1fecad60e3a550177fb2b1ea78d6cd0efca9eebfcfdd1b8bafebebe1314b7',
  'legacy with flow': 'ae3d0b38c88d746736012fb0a50432dfabd6a94fa6ac16506803853c7ae0bcd1',
  'split agent with no automation': '8a145b010b7114774d65093e370f252c7c55cd4632320f78985a16a42c3ae510',
  'split pair with job': 'caeb658938c60c42e1b51a748b7bbd2d373ea0e9aa0c8262bebdc38cbb602f87',
  'home-board agent': '43993b19e22ca354d964f4310251dc226e20f7635deb2b65b3570d03ef0bc953',
};

function withoutSoulProperty(m: AutomationManifest): AutomationManifest {
  const copy = { ...m } as Partial<AutomationManifest>;
  delete copy.soul;
  return copy as AutomationManifest;
}

describe('P1 byte identity: a soul-less manifest hashes exactly as before the soul existed', () => {
  for (const [name, m] of Object.entries(fixtures())) {
    it(name, () => {
      expect(GOLDEN[name]).toMatch(/^[0-9a-f]{64}$/);
      expect(manifestHash(withoutSoulProperty(m))).toBe(GOLDEN[name]);
      expect(manifestHash({ ...m, soul: '' })).toBe(GOLDEN[name]);
      expect(manifestHash({ ...m, soul: '   \n' })).toBe(GOLDEN[name]);
      expect(manifestHash({ ...m, soul: undefined as unknown as string })).toBe(GOLDEN[name]);
    });
  }
});

describe('P3 sensitivity', () => {
  const base = legacy({ soul: '' });
  it('adding, editing one character of, and removing a soul each change the hash', () => {
    const none = manifestHash(base);
    const added = manifestHash({ ...base, soul: 'Be terse.' });
    const edited = manifestHash({ ...base, soul: 'Be terse!' });
    expect(added).not.toBe(none);
    expect(edited).not.toBe(added);
    expect(manifestHash({ ...base, soul: '' })).toBe(none);
  });

  it('job = S and soul = S hash differently (the key names differ)', () => {
    expect(manifestHash({ ...base, job: 'Be terse.' })).not.toBe(manifestHash({ ...base, soul: 'Be terse.' }));
  });

  it('is normalized like job: CRLF and surrounding whitespace do not count', () => {
    expect(manifestHash({ ...base, soul: '  Be terse.\r\nNo praise.\n\n' })).toBe(manifestHash({ ...base, soul: 'Be terse.\nNo praise.' }));
  });
});

describe('P4 position: soul is the LAST key and everything before it is byte-equal', () => {
  for (const [name, m] of Object.entries(fixtures())) {
    it(name, () => {
      const without = canonicalApprovalPayload({ ...m, soul: '' });
      const withSoul = canonicalApprovalPayload({ ...m, soul: 'Lead with the worst problem.' });
      const json = JSON.parse(withSoul.slice(withSoul.indexOf('\n') + 1)) as Record<string, unknown>;
      expect(Object.keys(json).at(-1)).toBe('soul');
      const suffix = `,"soul":${JSON.stringify('Lead with the worst problem.')}}`;
      expect(withSoul.endsWith(suffix)).toBe(true);
      expect(`${withSoul.slice(0, -suffix.length)}}`).toBe(without);
    });
  }
});

describe('P5 lockstep: the review shows the soul', () => {
  it('APPROVAL_DIFF_FIELDS equals approvalFields keys in order and ends with soul, then autonomy', () => {
    const m = legacy({ soul: 'Be terse.' });
    expect([...APPROVAL_DIFF_FIELDS]).toEqual(Object.keys(approvalFields(m)));
    expect(APPROVAL_DIFF_FIELDS.at(-1)).toBe('autonomy');
    expect(APPROVAL_DIFF_FIELDS.at(-2)).toBe('soul');
    expect(APPROVAL_DIFF_FIELDS.at(-3)).toBe('job');
  });

  it('renderApprovalReview has a soul: line, and approvalFields reads an absent soul as empty', () => {
    expect(renderApprovalReview(approvalFields(legacy({ soul: 'Be terse.' })))).toMatch(/^soul: Be terse\.$/m);
    expect(approvalFields(withoutSoulProperty(legacy())).soul).toBe('');
  });
});

describe('renderApprovalValue is total', () => {
  it('a stored-fields object written before soul existed diffs without throwing, and prints (none)', () => {
    const current = approvalFields(legacy({ soul: 'Be terse.' }));
    const { soul: _drop, ...stored } = current;
    let diff = '';
    expect(() => { diff = approvalDiff(stored as typeof current, current); }).not.toThrow();
    expect(diff).toContain('soul:');
    expect(diff).toContain('- (none)');
    expect(diff).toContain('+ Be terse.');
  });
});
