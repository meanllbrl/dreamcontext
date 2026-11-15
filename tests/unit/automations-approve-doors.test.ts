/**
 * kosullu-otomasyon end review r1: every dashboard door that approves a routine or an agent goes
 * through THE approve hooks (they send the shown hash and re-read a moved script), and draws the
 * condition with the one ConditionScript block above its review. A door that posts `/approve`
 * by hand is how the Super's band was missed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ServerResponse } from 'node:http';
import { sendIfConditionUnseen, shownWitness } from '../../src/server/routes/condition-witness.js';
import { ConditionNeedsWitness } from '../../src/lib/automations/registry.js';
import type { AutomationManifest } from '../../src/lib/automations/types.js';

const SRC = join(__dirname, '..', '..', 'dashboard', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('approve doors', () => {
  it('only the hooks post an approve: no component calls /approve itself', () => {
    const posting = files(SRC)
      .filter((p) => !/[\\/]hooks[\\/]use(Automations|Agents)\.ts$/.test(p))
      .filter((p) => /\/(automations|agents)\/\$\{[^}]+\}\/(approve\b|\$\{[^}]*'approve')/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p));
    expect(posting).toEqual([]);
  });

  it('both hooks require the shown hash and re-read on condition_unseen', () => {
    const autos = read('hooks/useAutomations.ts');
    expect(autos).toMatch(/shownHash: string \| undefined;/);
    expect(autos).toMatch(/if \(isConditionUnseen\(err\)\) void queryClient\.invalidateQueries\(\{ queryKey: \['automations', arg\.slug\] \}\)/);
    const agents = read('hooks/useAgents.ts');
    expect(agents).toMatch(/\{ slug: string; shownHash: string \| undefined; sessionId\?: string \}/);
    expect(agents).toMatch(/if \(isConditionUnseen\(err\)\) invalidateAgent\(queryClient, slug\)/);
  });

  for (const door of ['components/aiteam/TeamApproval.tsx', 'components/sleepy/super/SuperApprovalBand.tsx', 'components/sleepy/chat/AutomationApprovalCard.tsx']) {
    it(`${door} draws the condition with ConditionScript, sends the shown hash and names a moved script`, () => {
      const s = read(door);
      expect(s).toMatch(/<ConditionScript view=\{/);
      expect(s).toMatch(/shownHash/);
      expect(s).toMatch(/isConditionUnseen\(err\)/);
      expect(s).toMatch(/chat\.autocard\.condition\.unseen/);
    });
  }

  it('the AI Team row and the Super band offer no approve for a script that cannot run', () => {
    for (const door of ['components/aiteam/TeamApproval.tsx', 'components/sleepy/super/SuperApprovalBand.tsx']) {
      expect(read(door)).toMatch(/const ready = !!review && !detail\.isFetching && detail\.isFetchedAfterMount && !condition\.conditionError;/);
    }
  });
});

describe('the one server witness rule (condition-witness.ts)', () => {
  const fakeRes = () => {
    const r = { code: 0, body: '' } as { code: number; body: string };
    const res = {
      writeHead: (c: number) => { r.code = c; return res; },
      setHeader: () => res,
      end: (b?: string) => { r.body = b ?? ''; return res; },
      statusCode: 0,
      headersSent: false,
    };
    return { r, res: res as unknown as ServerResponse };
  };
  const m = { condition: 'test -s orders/new.csv' } as AutomationManifest;

  it('a condition with no shownHash is 409 condition_unseen; a hash is the shown witness; none needs none', () => {
    const a = fakeRes();
    expect(shownWitness(a.res, m, {})).toBeNull();
    expect(a.r.code).toBe(409);
    expect(a.r.body).toMatch(/condition_unseen/);
    expect(shownWitness(fakeRes().res, m, { shownHash: 'f'.repeat(64) })).toEqual({ kind: 'shown', hash: 'f'.repeat(64) });
    expect(shownWitness(fakeRes().res, {} as typeof m, {})).toBeUndefined();
  });

  it('a registry refusal for want of a witness is 409 too, anything else is not handled', () => {
    const a = fakeRes();
    expect(sendIfConditionUnseen(a.res, new ConditionNeedsWitness('Not approved: it changed since you looked.'))).toBe(true);
    expect(a.r.code).toBe(409);
    expect(sendIfConditionUnseen(fakeRes().res, new Error('x'))).toBe(false);
  });

  it('both approve routes use it, and the agent detail carries the condition and its hash', () => {
    const agents = readFileSync(join(__dirname, '..', '..', 'src', 'server', 'routes', 'agents.ts'), 'utf8');
    const autos = readFileSync(join(__dirname, '..', '..', 'src', 'server', 'routes', 'automations.ts'), 'utf8');
    for (const s of [agents, autos]) {
      expect(s).toMatch(/const witness = shownWitness\(res, \w+, body\);/);
      expect(s).toMatch(/if \(sendIfConditionUnseen\(res, err\)\) return;/);
    }
    expect(agents).toMatch(/\.\.\.conditionFacts\(target\),/);
  });
});
