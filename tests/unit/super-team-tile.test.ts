import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ordinal, teamForLine } from '../../dashboard/src/components/sleepy/super/TeamTile';
import type { SuperTeamJob } from '../../dashboard/src/lib/superTypes';

/**
 * super-v3 Ü1/Ü4 (frame T1-sonra): a member's stage card is led by who it is (face, name, field,
 * scope chip; an All-projects member's globe), says "For <job>", counts "Nth job with you" in
 * correct English (no "1 jobs"), and a waiting approval turns it pink with an Approve that OPENS
 * the existing witnessed approval card. The rendered proof is the super-v3.mjs frames.
 */
const SRC = (f: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', ...f.split('/')), 'utf-8');
const TILE = SRC('components/sleepy/super/TeamTile.tsx');
const I18N = SRC('context/I18nContext.tsx');

const job = (brief: string): SuperTeamJob => ({ id: 'j1', member: 'sage', runId: 'r1', jobKind: 'run', queued: false, brief, startedAt: 0 });

describe('the member card', () => {
  it('ordinals, never "1 jobs"', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect(I18N).toContain("'super.team.nthJob': '{ord} job with you'");
    expect(I18N).toContain("'super.team.nthJob': 'seninle {n}. iş'");
    expect(TILE).not.toContain("t('superStage.team.jobs')");
  });
  it('"For <job>": the brief\'s headline, then what it does now', () => {
    expect(teamForLine({ job: job('Fiyat sayfası: compare 3 competitors and suggest a yearly price'), lastLine: 'comparing 3 competitor prices' }))
      .toEqual({ job: 'Fiyat sayfası', doing: 'comparing 3 competitor prices' });
    expect(teamForLine({ job: job('A very long brief headline that goes on and on past forty characters'), lastLine: '' }).job.length).toBeLessThanOrEqual(40);
  });
  it('an All-projects member carries the globe and the "All projects" chip; a project member "<project> team"', () => {
    expect(TILE).toContain("const global = agent?.scope === 'global';");
    expect(TILE).toContain('{global && <span className="super-team-globe"');
    expect(TILE).toContain("t('super.team.allProjects')");
    expect(TILE).toContain("t('super.team.projectTeam')");
  });
  it('a waiting approval turns the card pink; Approve opens the witnessed card, approving nothing itself', () => {
    expect(TILE).toContain("const kind = card.approval ? 'asking' : teamRingKind(status);");
    expect(TILE).toContain('openMemberApproval(card.job.member)');
    expect(TILE).not.toMatch(/useApproveAgent|approveAsOwner|manifestHash/);
    const band = SRC('components/sleepy/super/SuperApprovalBand.tsx');
    expect(band).toContain('window.addEventListener(OPEN_APPROVAL_EVENT, on);');
    expect(band).toContain('if (row) setOpen(row.key);');
  });
});
