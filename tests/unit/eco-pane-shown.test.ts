/**
 * The composer's ECO lamp (owner 2026-11-22: "when I turn Eco on it must be on in every
 * project"): a pane nobody toggled shows this Mac's Eco mode as Settings holds it now; a pane a
 * person switched keeps its own answer. The server's frame says which one it is (`chosen`).
 */
import { describe, it, expect } from 'vitest';
import { shownContextHandoff, toChatEvent } from '../../dashboard/src/lib/chatProtocol.js';

const LADDER = { nudgeAt: 300_000, hardAt: 650_000, remindEvery: 100_000 };

describe('shownContextHandoff', () => {
  it('a seeded pane follows the Mac switch both ways', () => {
    expect(shownContextHandoff({ ...LADDER, enabled: false, chosen: false }, true)?.enabled).toBe(true);
    expect(shownContextHandoff({ ...LADDER, enabled: true }, false)?.enabled).toBe(false);
  });

  it('a chosen pane keeps its own answer', () => {
    expect(shownContextHandoff({ ...LADDER, enabled: false, chosen: true }, true)?.enabled).toBe(false);
    expect(shownContextHandoff({ ...LADDER, enabled: true, chosen: true }, false)?.enabled).toBe(true);
  });

  it('no frame yet stays no frame', () => {
    expect(shownContextHandoff(undefined, true)).toBeUndefined();
  });
});

describe('the context_handoff frame carries chosen', () => {
  it('reads chosen strictly: only a real true', () => {
    const ev = (chosen: unknown) => toChatEvent({ type: '_meta', subtype: 'context_handoff', state: { enabled: true, ...LADDER, chosen } });
    expect(ev(true)).toMatchObject({ kind: 'context-handoff', state: { chosen: true } });
    expect(ev('true')).toMatchObject({ kind: 'context-handoff', state: { chosen: false } });
    expect(ev(undefined)).toMatchObject({ kind: 'context-handoff', state: { chosen: false } });
  });
});
