// The Super Agent's own chat is opened by the window automatically (a mount, a reload, an app
// reopen, a second window). A plain resume was a RESPAWN to the server: a second Super process
// on the pin beside the live one (field 2026-11-14). It opens PASSIVE, so the server adopts the
// live process, and resumes in a new one only when none runs.

import { describe, expect, it } from 'vitest';
import { superPaneOpen } from '../../dashboard/src/components/sleepy/super/sessionHome';
import { REATTACH_PASSIVE } from '../../dashboard/src/components/handsfree/macContract';

describe('superPaneOpen', () => {
  it('an existing Super session reattaches passively, never respawns', () => {
    expect(superPaneOpen(false)).toEqual({ resume: true, reattach: REATTACH_PASSIVE });
  });
  it('a session the hand-over just minted starts under its id (nothing to reattach to)', () => {
    expect(superPaneOpen(true)).toEqual({ resume: false, reattach: '' });
  });
});
