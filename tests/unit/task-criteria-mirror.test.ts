/**
 * The task page's tick (dashboard/src/components/tasks/page/criteriaEdit.ts) flips the box the
 * server reads (src/lib/task-evidence.ts), on one case table (mirror-with-drift-test pattern):
 * criterion n is the n-th box under `## Acceptance Criteria`, fences skipped, nothing else in
 * the body moves.
 */
import { describe, it, expect } from 'vitest';
import { criteriaOfBody } from '../../src/lib/task-evidence.js';
import { toggleCriterion, updateMermaidNodeStatus } from '../../dashboard/src/components/tasks/page/criteriaEdit.js';

const BODIES: Record<string, string> = {
  plain: [
    '## Why', '', '- [ ] not a criterion (Why section)', '',
    '## Acceptance Criteria', '', '- [ ] Parser works', '- [x] Docs updated (evidence: commit:abc1234)', '* [ ] Star bullet', '',
    '## Notes', '', '- [ ] not a criterion either',
  ].join('\n'),
  fenced: [
    '## Acceptance Criteria', '', '- [ ] First', '```', '- [ ] inside a fence', '```', '- [ ] Second <!-- node:s2 -->', '',
  ].join('\n'),
  heading: [
    '## acceptance criteria', '', '1. not a box', '- [X] Upper-case box (evidence: legacy)', '  - [ ] Nested box',
  ].join('\n'),
};

describe('the dashboard tick flips the criterion the server numbers', () => {
  for (const [name, body] of Object.entries(BODIES)) {
    it(`${name}: every criterion, both ways`, () => {
      const server = criteriaOfBody(body);
      expect(server.length).toBeGreaterThan(0);
      for (const c of server) {
        for (const checked of [true, false]) {
          const out = toggleCriterion(body, c.n, checked);
          expect(out, `${name} #${c.n}`).not.toBeNull();
          const after = criteriaOfBody(out!.body);
          expect(after.map((x) => x.text)).toEqual(server.map((x) => x.text));
          for (const x of after) expect(x.checked, `${name} #${x.n} after ticking #${c.n}`).toBe(x.n === c.n ? checked : server[x.n - 1].checked);
          // Only the criterion's own line changes.
          const before = body.split('\n');
          const changed = out!.body.split('\n').filter((l, i) => l !== before[i]);
          expect(changed.length).toBeLessThanOrEqual(1);
        }
      }
    });
  }

  it('an unknown criterion or a body with no criteria section is null', () => {
    expect(toggleCriterion(BODIES.plain, 99, true)).toBeNull();
    expect(toggleCriterion('## Why\n\n- [ ] x', 1, true)).toBeNull();
  });

  it('names the mermaid node a criterion carries, and rewrites only its definition', () => {
    const out = toggleCriterion(BODIES.fenced, 2, true)!;
    expect(out.nodeId).toBe('s2');
    const chart = ['```mermaid', 'flowchart TD', '  s2[Second]:::todo', '  s1 --> s2', '```'].join('\n');
    expect(updateMermaidNodeStatus(chart, 's2', true)).toBe(chart.replace('s2[Second]:::todo', 's2[Second]:::done'));
  });
});
