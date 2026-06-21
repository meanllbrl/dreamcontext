import { describe, it, expect } from 'vitest';

import {
  statusToGitHub,
  deleteToGitHub,
  subStatusLabel,
  statusFromLabels,
  statusFromGitHub,
  labelsToGitHub,
  labelsFromGitHub,
  labelNamesOf,
  isReservedLabel,
  bodyToIssueBody,
  splitChangelogEntries,
  normalizeEntry,
  githubTimeMs,
  githubTimeIso,
  DELETED_SENTINEL,
  STATE_REASON_COMPLETED,
  STATE_REASON_NOT_PLANNED,
  STATE_REASON_REOPENED,
} from '../../src/lib/task-backend/github-map.js';

/**
 * Pure dreamcontext ↔ GitHub Issues mapping (parallels the clickup-map tests).
 * No I/O, no network — every assertion is on a pure function.
 */

describe('status push mapping (dreamcontext → GitHub state/state_reason)', () => {
  it('completed closes the issue as completed (the only status that closes)', () => {
    expect(statusToGitHub('completed')).toEqual({ state: 'closed', state_reason: STATE_REASON_COMPLETED });
  });

  it('open states stay open and carry no state_reason (sub-status rides a label)', () => {
    expect(statusToGitHub('todo')).toEqual({ state: 'open' });
    expect(statusToGitHub('in_progress')).toEqual({ state: 'open' });
    expect(statusToGitHub('in_review')).toEqual({ state: 'open' });
  });

  it('reopen carries state_reason:reopened on an open patch', () => {
    expect(statusToGitHub('in_progress', { reopen: true })).toEqual({
      state: 'open',
      state_reason: STATE_REASON_REOPENED,
    });
    // completed always closes — reopen has no effect on a completed push.
    expect(statusToGitHub('completed', { reopen: true })).toEqual({
      state: 'closed',
      state_reason: STATE_REASON_COMPLETED,
    });
  });

  it('an unknown status degrades to an open issue (treated as todo)', () => {
    expect(statusToGitHub('on_hold')).toEqual({ state: 'open' });
  });

  it('delete is a SOFT delete: close as not_planned (no hard delete on REST)', () => {
    expect(deleteToGitHub()).toEqual({ state: 'closed', state_reason: STATE_REASON_NOT_PLANNED });
  });

  it('sub-status labels: in_progress/in_review get a dc: label, todo/completed do not', () => {
    expect(subStatusLabel('in_progress')).toBe('dc:in-progress');
    expect(subStatusLabel('in_review')).toBe('dc:in-review');
    expect(subStatusLabel('todo')).toBeNull();
    expect(subStatusLabel('completed')).toBeNull();
  });
});

describe('statusFromLabels (open-issue sub-status, default todo)', () => {
  it('reads the dc: label, defaults to todo when absent', () => {
    expect(statusFromLabels(['dc:in-progress'])).toBe('in_progress');
    expect(statusFromLabels(['dc:in-review'])).toBe('in_review');
    expect(statusFromLabels(['dc:todo'])).toBe('todo');
    expect(statusFromLabels(['bug', 'frontend'])).toBe('todo');
    expect(statusFromLabels([])).toBe('todo');
  });

  it('is case-insensitive on the dc: label', () => {
    expect(statusFromLabels(['DC:In-Progress'])).toBe('in_progress');
  });
});

describe('statusFromGitHub (GitHub issue → dreamcontext status)', () => {
  it('closed + completed → completed', () => {
    expect(statusFromGitHub({ state: 'closed', state_reason: 'completed', labels: [] })).toBe('completed');
  });

  it('closed + not_planned → the delete sentinel (remove local mirror)', () => {
    expect(statusFromGitHub({ state: 'closed', state_reason: 'not_planned', labels: [] })).toBe(DELETED_SENTINEL);
  });

  it('a bare close (no state_reason) is treated as completed', () => {
    expect(statusFromGitHub({ state: 'closed', state_reason: null, labels: [] })).toBe('completed');
  });

  it('open + dc: label → that sub-status; open + no label → todo', () => {
    expect(statusFromGitHub({ state: 'open', state_reason: 'reopened', labels: [{ name: 'dc:in-review' }] })).toBe('in_review');
    expect(statusFromGitHub({ state: 'open', state_reason: null, labels: [{ name: 'bug' }] })).toBe('todo');
    expect(statusFromGitHub({ state: 'open', state_reason: null, labels: [] })).toBe('todo');
  });
});

describe('label compose / decompose (priority + urgency + tags + version + dc:*)', () => {
  it('labelsToGitHub composes user tags + reserved-prefix fields + sub-status', () => {
    expect(
      labelsToGitHub({
        tags: ['backend', 'cli'],
        priority: 'high',
        urgency: 'low',
        version: 'v0.9.0',
        status: 'in_progress',
      }),
    ).toEqual(['backend', 'cli', 'priority:high', 'urgency:low', 'version:v0.9.0', 'dc:in-progress']);
  });

  it('omits unset structured fields and the dc: label for todo/completed', () => {
    expect(labelsToGitHub({ tags: ['x'], priority: 'medium', status: 'todo' })).toEqual(['x', 'priority:medium']);
    expect(labelsToGitHub({ tags: [], status: 'completed' })).toEqual([]);
  });

  it('de-dups so a user tag colliding with a structured label appears once', () => {
    expect(labelsToGitHub({ tags: ['priority:high'], priority: 'high' })).toEqual(['priority:high']);
  });

  it('labelsFromGitHub splits reserved prefixes out and keeps the rest as user tags', () => {
    expect(
      labelsFromGitHub(['backend', 'cli', 'priority:high', 'urgency:low', 'version:v0.9.0', 'dc:in-progress']),
    ).toEqual({ tags: ['backend', 'cli'], priority: 'high', urgency: 'low', version: 'v0.9.0' });
  });

  it('defaults priority to medium and urgency/version to null when absent (ClickUp parity)', () => {
    expect(labelsFromGitHub(['bug'])).toEqual({ tags: ['bug'], priority: 'medium', urgency: null, version: null });
    expect(labelsFromGitHub([])).toEqual({ tags: [], priority: 'medium', urgency: null, version: null });
  });

  it('ignores an unknown priority value, keeping the medium default', () => {
    expect(labelsFromGitHub(['priority:bananas']).priority).toBe('medium');
  });

  it('round-trips tags + priority + urgency + version + dc:* through compose→decompose', () => {
    const original = { tags: ['backend', 'cli'], priority: 'critical', urgency: 'high', version: 'v1.2.3' };
    const composed = labelsToGitHub({ ...original, status: 'in_review' });
    const back = labelsFromGitHub(composed);
    expect(back).toEqual(original);
    // and the sub-status survives separately
    expect(statusFromLabels(composed)).toBe('in_review');
  });

  it('labelNamesOf accepts both object labels and bare strings', () => {
    expect(labelNamesOf([{ name: 'a' }, 'b', { name: '' }, null as any])).toEqual(['a', 'b']);
    expect(labelNamesOf(null)).toEqual([]);
    expect(labelNamesOf(undefined)).toEqual([]);
  });

  it('isReservedLabel flags structured labels, not user tags', () => {
    expect(isReservedLabel('priority:high')).toBe(true);
    expect(isReservedLabel('dc:in-review')).toBe(true);
    expect(isReservedLabel('version:v1')).toBe(true);
    expect(isReservedLabel('backend')).toBe(false);
  });
});

describe('bodyToIssueBody (strips the ## Changelog section)', () => {
  it('drops everything from the ## Changelog heading onward', () => {
    const body = [
      '## Why',
      'because reasons',
      '',
      '## Changelog',
      '### 2026-06-21 - Created',
      '- did a thing',
      '',
    ].join('\n');
    const issueBody = bodyToIssueBody(body);
    expect(issueBody).toContain('## Why');
    expect(issueBody).toContain('because reasons');
    expect(issueBody).not.toContain('## Changelog');
    expect(issueBody).not.toContain('did a thing');
  });

  it('a later ## heading after Changelog re-enables output (section boundary, not greedy tail)', () => {
    const body = ['## A', 'a', '## Changelog', '### x', '## B', 'b', ''].join('\n');
    const out = bodyToIssueBody(body);
    expect(out).toContain('## A');
    expect(out).toContain('## B');
    expect(out).not.toContain('### x');
  });
});

describe('changelog ↔ comments (split / normalize / dedup)', () => {
  it('splits a changelog section into ### entries', () => {
    const section = ['### 2026-06-21 - A', '- one', '### 2026-06-20 - B', '- two'].join('\n');
    const entries = splitChangelogEntries(section);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('### 2026-06-21 - A');
    expect(entries[1]).toContain('### 2026-06-20 - B');
  });

  it('normalizeEntry collapses whitespace for dedup across round-trips', () => {
    const a = '### 2026-06-21 - A\n-   one    two';
    const b = '###   2026-06-21 - A\n- one two';
    expect(normalizeEntry(a)).toBe(normalizeEntry(b));
  });

  it('union-merge dedup: a comment already present is not re-added', () => {
    const local = splitChangelogEntries(['### A', '- x', '### B', '- y'].join('\n'));
    const remoteComment = '### A\n- x';
    const seen = new Set(local.map(normalizeEntry));
    expect(seen.has(normalizeEntry(remoteComment))).toBe(true);
    const remoteNew = '### C\n- z';
    expect(seen.has(normalizeEntry(remoteNew))).toBe(false);
  });
});

describe('githubTimeMs / githubTimeIso (ISO-8601 watermark)', () => {
  it('parses an ISO-8601 string to epoch ms', () => {
    expect(githubTimeMs('2026-06-21T12:00:00Z')).toBe(Date.parse('2026-06-21T12:00:00Z'));
  });

  it('returns null for null/undefined/garbage', () => {
    expect(githubTimeMs(null)).toBeNull();
    expect(githubTimeMs(undefined)).toBeNull();
    expect(githubTimeMs('not-a-date')).toBeNull();
  });

  it('round-trips ms → ISO → ms', () => {
    const ms = Date.parse('2026-06-21T12:00:00Z');
    const iso = githubTimeIso(ms);
    expect(iso).toBe('2026-06-21T12:00:00.000Z');
    expect(githubTimeMs(iso)).toBe(ms);
  });

  it('githubTimeIso returns null for null/garbage ms', () => {
    expect(githubTimeIso(null)).toBeNull();
    expect(githubTimeIso(undefined)).toBeNull();
    expect(githubTimeIso(Number.NaN)).toBeNull();
  });
});
