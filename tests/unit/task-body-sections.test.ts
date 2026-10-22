import { describe, it, expect } from 'vitest';
import {
  checkItems, latestEntries, missingSections, splitSections, toggleCheckbox, toggleCriterion, updateMermaidNodeStatus,
} from '../../dashboard/src/components/tasks/detail/sectionModel';

/** The detail drawer's reading of a task body (AC10, AC11, AC16). */

const BODY = [
  '## Why',
  'Because the board is crowded.',
  '',
  '## User Stories',
  '- [ ] As an owner I add a subtask',
  '- [x] As an owner I see progress',
  '',
  '## Acceptance Criteria',
  '- [ ] AC1 first <!-- node:a1 -->',
  '- [x] AC2 second',
  '```',
  '- [ ] not a criterion (fenced)',
  '```',
  '- [ ] AC3 third',
  '',
  '## Workflow',
  '```mermaid',
  'flowchart TD',
  '  a1[First step]:::todo',
  '  a2[Second step]:::todo',
  '  a1 --> a2',
  '```',
  '',
  '## Odd Heading',
  'Something custom.',
  '',
  '## Notes',
  '- [ ] a note checkbox',
  '',
  '## Changelog',
  '### 2026-10-22 - Update',
  '- newest',
  '### 2026-10-21 - Update',
  '- middle',
  '### 2026-10-20 - Created',
  '- oldest',
].join('\n');

describe('splitSections', () => {
  it('keeps the file order, incl. workflow and an unknown heading as other', () => {
    expect(splitSections(BODY).map((s) => s.key)).toEqual([
      'why', 'user_stories', 'acceptance_criteria', 'workflow', 'other', 'notes', 'changelog',
    ]);
    expect(splitSections(BODY).find((s) => s.key === 'other')?.heading).toBe('Odd Heading');
  });

  it('a ## inside fenced code is not a heading', () => {
    const b = '## Notes\n```\n## not a heading\n```\ntext';
    expect(splitSections(b).map((s) => s.key)).toEqual(['notes']);
  });
});

describe('toggleCheckbox (scoped per section)', () => {
  it('flips exactly the k-th checkbox of that section', () => {
    const r = toggleCheckbox(BODY, 'acceptance_criteria', 2)!;
    expect(r.checked).toBe(true);
    const lines = r.body.split('\n');
    expect(lines).toContain('- [x] AC3 third');
    // nothing else moved: user stories, notes and the fenced line keep their state
    expect(lines).toContain('- [ ] As an owner I add a subtask');
    expect(lines).toContain('- [ ] a note checkbox');
    expect(lines).toContain('- [ ] not a criterion (fenced)');
    expect(r.body.split('\n').filter((l, i) => l !== BODY.split('\n')[i])).toEqual(['- [x] AC3 third']);
  });

  it('skips fenced code when counting', () => {
    expect(checkItems(BODY, 'acceptance_criteria').map((i) => i.text)).toEqual(['AC1 first <!-- node:a1 -->', 'AC2 second', 'AC3 third']);
  });

  it('user stories index 0 is the user story, not the first criterion', () => {
    const r = toggleCheckbox(BODY, 'user_stories', 0)!;
    expect(r.body).toContain('- [x] As an owner I add a subtask');
    expect(r.body).toContain('- [ ] AC1 first');
  });

  it('returns the linked mermaid node id', () => {
    expect(toggleCheckbox(BODY, 'acceptance_criteria', 0)!.nodeId).toBe('a1');
    expect(toggleCheckbox(BODY, 'acceptance_criteria', 1)!.nodeId).toBeNull();
  });

  it('out of range or a missing section is null', () => {
    expect(toggleCheckbox(BODY, 'acceptance_criteria', 9)).toBeNull();
    expect(toggleCheckbox(BODY, 'constraints', 0)).toBeNull();
  });

  it('an explicit state is applied, not flipped', () => {
    expect(toggleCheckbox(BODY, 'acceptance_criteria', 1, true)!.body).toBe(BODY);
  });
});

describe('mermaid node sync', () => {
  it('ticking a linked criterion moves its node to :::done, leaving edges alone', () => {
    const next = toggleCriterion(BODY, 'acceptance_criteria', 0)!;
    expect(next).toContain('- [x] AC1 first <!-- node:a1 -->');
    expect(next).toContain('  a1[First step]:::done');
    expect(next).toContain('  a2[Second step]:::todo');
    expect(next).toContain('  a1 --> a2');
  });

  it('updateMermaidNodeStatus unticks back to :::todo', () => {
    const done = updateMermaidNodeStatus(BODY, 'a1', true);
    expect(updateMermaidNodeStatus(done, 'a1', false)).toBe(BODY);
  });
});

describe('latestEntries', () => {
  it('changelog: the newest n ### blocks and the total', () => {
    const sec = splitSections(BODY).find((s) => s.key === 'changelog')!;
    const r = latestEntries(sec.text, 2, 'changelog');
    expect(r.total).toBe(3);
    expect(r.entries[0]).toContain('newest');
    expect(r.entries[1]).toContain('middle');
  });

  it('constraints: top-level bullets with their continuation lines, comments ignored', () => {
    const text = '<!-- hint -->\n- **[2026-10-22]** one\n  more of one\n- **[2026-10-21]** two\n- **[2026-10-20]** three\n- **[2026-10-19]** four';
    const r = latestEntries(text, 3, 'constraints');
    expect(r.total).toBe(4);
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0]).toBe('- **[2026-10-22]** one\n  more of one');
  });
});

describe('missingSections', () => {
  it('lists the template sections the body lacks (or has only empty)', () => {
    expect(missingSections(BODY)).toEqual(['constraints', 'technical_details']);
    expect(missingSections('## Why\n<!-- hint only -->\n')).toContain('why');
  });
});

describe('checkbox counting matches what marked renders', () => {
  it('counts ordered task items, skips commented examples, keeps CRLF', () => {
    const b = '## User Stories\r\n<!--\r\n- [ ] example hint\r\n-->\r\n1. [ ] first story\r\n2. [x] second story\r\n- [ ] third story\r\n';
    expect(checkItems(b, 'user_stories').map((i) => i.text)).toEqual(['first story', 'second story', 'third story']);
    const r = toggleCheckbox(b, 'user_stories', 2)!;
    expect(r.body).toContain('- [x] third story\r\n');
    expect(r.body).toContain('- [ ] example hint');
    expect(toggleCheckbox(b, 'user_stories', 0)!.body).toContain('1. [x] first story\r\n');
  });
});
