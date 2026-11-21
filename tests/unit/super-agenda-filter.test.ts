/** The agenda's job rows (super-v3 D9, Ü4): tap = filter + About, Stop while it runs, docked = one row, a member approval row with its face. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rowActions } from '../../dashboard/src/components/sleepy/super/agendaGroups.js';

const SRC = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'SuperAgenda.tsx'), 'utf-8');
const HANDOVER = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'superHandover.ts'), 'utf-8');

describe('the agenda as the job filter', () => {
  it('a job line tap selects it (stays purple), narrows the chat and puts its About chip in the composer', () => {
    expect(SRC).toContain('const next = jobSelected === r.for ? null : r.for;');
    expect(SRC).toContain('if (next && ask) ask();');
    expect(SRC).toContain('selected={selected === e.key || (!!jobSelected && r.for === jobSelected)}');
  });
  it('Stop rides a live line and a question row, only while its job runs', () => {
    expect(rowActions({ kind: 'line', live: true, row: { section: 'now' } as never }).hover).toEqual(['done', 'ask', 'stop']);
    expect(rowActions({ kind: 'line', live: true, row: { section: 'done' } as never }).hover).toEqual(['ask']);
    expect(SRC).toContain('stop: onStop && r.for && e.live && jobRuns(r.for) ? () => onStop(r.for as string) : undefined');
  });
  it('docked: the running lines leave Today and one row says so', () => {
    expect(SRC).toContain("super: allGroups.super.filter((x) => !running(x.row?.for))");
    expect(SRC).toContain('data-testid="super-agenda-running-dock"');
  });
  it('a member approval is named by the member, with its face, and opens the witnessed row', () => {
    expect(HANDOVER).toContain("if (q.kind === 'approval' && q.member) {");
    expect(SRC).toContain("if (r.member && r.chip !== 'approval')");
    expect(SRC).toContain('face={r.member ? <MemberFace slug={r.member} title={r.text} /> : undefined}');
  });
});
