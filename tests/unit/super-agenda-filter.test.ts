/** The agenda's job rows (super-v3 D9, Ü4): tap = filter + About, Stop while it runs, docked = one row, a member approval row with its face. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowActions } from '../../dashboard/src/components/sleepy/super/agendaGroups.js';

const SRC = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'SuperAgenda.tsx'), 'utf-8');
const HANDOVER = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'superHandover.ts'), 'utf-8');

describe('the agenda as the job filter', () => {
  // Local cut (2026-11-20): the owner-approved agenda design wins over super-v3's row changes: a line's hover holds
  // Ask alone (Done lives in the detail), a press filters the chat by the line's thread, no member face, no Stop on the line.
  it('a line keeps the approved agenda design: Ask alone on hover', () => {
    expect(rowActions({ kind: 'line', live: true, row: { section: 'now' } as never }).hover).toEqual(['ask']);
    expect(rowActions({ kind: 'line', live: true, row: { section: 'done' } as never }).hover).toEqual(['ask']);
  });
  it('docked: the running lines leave Today and one row says so', () => {
    expect(SRC).toContain("super: allGroups.super.filter((x) => !running(x.row?.for))");
    expect(SRC).toContain('data-testid="super-agenda-running-dock"');
  });
  it('a member approval is named by the member, and opens the witnessed row', () => {
    expect(HANDOVER).toContain("if (q.kind === 'approval' && q.member) {");
    expect(SRC).toContain("if (r.member && r.chip !== 'approval')");
  });
});
