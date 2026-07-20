import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleThesesList,
  handleThesesCreate,
  handleThesesShow,
  handleThesesUpdate,
  handleThesesDelete,
  handleThesesAddPrediction,
  handleThesesAddEvidence,
  handleThesesSetStatus,
  handleThesesLink,
  handleThesesUnlink,
  handleThesesChangelog,
  handleThesesPromote,
  handleLearningEnable,
  handleLearningDisable,
} from '../../src/server/routes/theses.js';
import { createThesis, thesisPath } from '../../src/lib/theses/store.js';
import { createInsight } from '../../src/lib/lab/store.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { buildRoadmapModel } from '../../src/lib/roadmap-model.js';
import { readSetupConfig } from '../../src/lib/setup-config.js';

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, bodyObj?: unknown, url = '/'): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, { method, url, headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
}

let projectRoot: string;
let root: string; // contextRoot = projectRoot/_dream_context

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-theses-routes-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('GET /api/theses — list', () => {
  it('returns enabled:false and an empty list with no theses dir', async () => {
    const { res, status, body } = makeRes();
    await handleThesesList(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().enabled).toBe(false);
    expect(body().theses).toEqual([]);
    expect(body().candidates).toBeNull();
  });

  it('works while the learning layer is disabled (read is never gated)', async () => {
    createThesis(root, { slug: 'memory-compression-helps', claim: 'Compressing stale memories improves recall precision.' });
    const config = readSetupConfig(projectRoot);
    expect(config?.learning?.enabled).not.toBe(true);
    const { res, status, body } = makeRes();
    await handleThesesList(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().enabled).toBe(false);
    expect(body().theses).toHaveLength(1);
    expect(body().theses[0].slug).toBe('memory-compression-helps');
    expect(body().theses[0].confidence).toBeCloseTo(0.5);
  });

  it('reflects enabled:true after /api/learning/enable', async () => {
    await handleLearningEnable(makeReq('POST'), makeRes().res, {}, root);
    const { res, body } = makeRes();
    await handleThesesList(makeReq('GET'), res, {}, root);
    expect(body().enabled).toBe(true);
  });
});

describe('GET /api/theses — candidates staging round-trip (theses/.candidates.json)', () => {
  function writeCandidatesFile(contents: unknown): void {
    const dir = join(root, 'theses');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.candidates.json'), JSON.stringify(contents), 'utf-8');
  }

  it('round-trips the canonical shape written directly to disk (note + items[].claim)', async () => {
    writeCandidatesFile({
      note: 'meeting-notes-2026-07-19.md',
      items: [
        { claim: 'Shorter sleep cycles improve consolidation quality.' },
        { claim: 'Compressing stale memories improves recall precision.' },
      ],
    });
    const { res, status, body } = makeRes();
    await handleThesesList(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().candidates).not.toBeNull();
    expect(body().candidates.note).toBe('meeting-notes-2026-07-19.md');
    expect(body().candidates.items.map((i: any) => i.claim)).toEqual([
      'Shorter sleep cycles improve consolidation quality.',
      'Compressing stale memories improves recall precision.',
    ]);
  });

  it('drops malformed bare-string items safely (never 500s)', async () => {
    writeCandidatesFile({
      note: 'meeting-notes-2026-07-19.md',
      items: ['Shorter sleep cycles improve consolidation quality.', 'Compressing stale memories improves recall precision.'],
    });
    const { res, status, body } = makeRes();
    await handleThesesList(makeReq('GET'), res, {}, root);
    expect(status()).toBe(200);
    expect(body().candidates.note).toBe('meeting-notes-2026-07-19.md');
    expect(body().candidates.items).toEqual([]);
  });
});

describe('POST /api/theses — create', () => {
  it('creates a draft thesis from a claim', async () => {
    const { res, status, body } = makeRes();
    await handleThesesCreate(makeReq('POST', { claim: 'Shorter sleep cycles improve consolidation quality.' }), res, {}, root);
    expect(status()).toBe(201);
    expect(body().thesis.status).toBe('draft');
    expect(body().thesis.kind).toBe('observational');
    expect(body().thesis.confidence).toBeCloseTo(0.5);
  });

  it('400s on a missing claim', async () => {
    const { res, status } = makeRes();
    await handleThesesCreate(makeReq('POST', {}), res, {}, root);
    expect(status()).toBe(400);
  });

  it('400s when open:true is requested without a prediction', async () => {
    const { res, status, body } = makeRes();
    await handleThesesCreate(makeReq('POST', { claim: 'X improves Y.', open: true }), res, {}, root);
    expect(status()).toBe(400);
    expect(body().error).toBe('create_rejected');
  });

  it('creates open with a prediction, and links a real insight/objective', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    createObjective(root, { slug: 'improve-retention', title: 'Improve retention' });
    const { res, status, body } = makeRes();
    await handleThesesCreate(makeReq('POST', {
      claim: 'X improves Y.',
      open: true,
      predictions: ['WAU rises 10% within 2 cycles'],
      insights: ['wau'],
      objectives: ['improve-retention'],
    }), res, {}, root);
    expect(status()).toBe(201);
    expect(body().thesis.status).toBe('open');
    expect(body().thesis.predictions).toHaveLength(1);
    expect(body().thesis.insights).toEqual(['wau']);
    expect(body().thesis.objectives).toEqual(['improve-retention']);
  });

  it('400s when a linked insight does not exist', async () => {
    const { res, status } = makeRes();
    await handleThesesCreate(makeReq('POST', { claim: 'X improves Y.', insights: ['nope'] }), res, {}, root);
    expect(status()).toBe(400);
  });
});

describe('GET /api/theses/:slug — show', () => {
  it('returns thesis + confidence breakdown + changelog', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesShow(makeReq('GET'), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.slug).toBe('t1');
    expect(body().confidence.confidence).toBeCloseTo(0.5);
    expect(body().confidence.supports).toBe(0);
    expect(body().changelog).toEqual([]);
  });

  it('404s for an unknown slug', async () => {
    const { res, status } = makeRes();
    await handleThesesShow(makeReq('GET'), res, { slug: 'nope' }, root);
    expect(status()).toBe(404);
  });
});

describe('PATCH /api/theses/:slug — update', () => {
  it('updates claim and kind', async () => {
    createThesis(root, { slug: 't1', claim: 'Old claim.' });
    const { res, status, body } = makeRes();
    await handleThesesUpdate(makeReq('PATCH', { claim: 'New claim.', kind: 'experimental' }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.claim).toBe('New claim.');
    expect(body().thesis.kind).toBe('experimental');
  });

  it('sets and clears the blocked-on-instrumentation flag', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    {
      const { res, status, body } = makeRes();
      await handleThesesUpdate(makeReq('PATCH', { blocked: { metric: 'weekly retention' } }), res, { slug: 't1' }, root);
      expect(status()).toBe(200);
      expect(body().thesis.blocked_on_instrumentation).toBe(true);
      expect(body().thesis.blocked_metric).toBe('weekly retention');
    }
    {
      const { res, status, body } = makeRes();
      await handleThesesUpdate(makeReq('PATCH', { blocked: null }), res, { slug: 't1' }, root);
      expect(status()).toBe(200);
      expect(body().thesis.blocked_on_instrumentation).toBe(false);
    }
  });

  it('400s on an invalid kind, 404s for an unknown slug', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    {
      const { res, status } = makeRes();
      await handleThesesUpdate(makeReq('PATCH', { kind: 'bogus' }), res, { slug: 't1' }, root);
      expect(status()).toBe(400);
    }
    {
      const { res, status } = makeRes();
      await handleThesesUpdate(makeReq('PATCH', { claim: 'X' }), res, { slug: 'nope' }, root);
      expect(status()).toBe(404);
    }
  });
});

describe('DELETE /api/theses/:slug — retire or hard-delete', () => {
  it('retires by default', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesDelete(makeReq('DELETE', undefined, '/api/theses/t1'), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().hard).toBe(false);
    expect(body().thesis.status).toBe('retired');
    expect(existsSync(thesisPath(root, 't1'))).toBe(true);
  });

  it('hard-deletes with ?hard=1', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesDelete(makeReq('DELETE', undefined, '/api/theses/t1?hard=1'), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().hard).toBe(true);
    expect(existsSync(thesisPath(root, 't1'))).toBe(false);
  });

  it('404s for an unknown slug', async () => {
    const { res, status } = makeRes();
    await handleThesesDelete(makeReq('DELETE'), res, { slug: 'nope' }, root);
    expect(status()).toBe(404);
  });
});

describe('POST /api/theses/:slug/predictions', () => {
  it('adds a prediction', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesAddPrediction(makeReq('POST', { text: 'Y rises 10%.' }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.predictions).toHaveLength(1);
    expect(body().thesis.predictions[0].standing).toBe('untested');
  });

  it('400s on missing text', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status } = makeRes();
    await handleThesesAddPrediction(makeReq('POST', {}), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
  });
});

describe('POST /api/theses/:slug/evidence — recomputes derived confidence', () => {
  it('appends supporting evidence and raises confidence above 0.5', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesAddEvidence(makeReq('POST', { verdict: 'supports', source: 'insight', ref: 'wau', note: 'WAU up 12%', quantitative: true }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.confidence).toBeCloseTo(1.4 / 1.8, 6);
    expect(body().thesis.cycles_checked).toBe(1);
  });

  it('400s on an invalid verdict/source', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status } = makeRes();
    await handleThesesAddEvidence(makeReq('POST', { verdict: 'maybe', source: 'insight' }), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
  });
});

describe('POST /api/theses/:slug/status — lifecycle flips', () => {
  it('draft→open requires a prediction (400 without one)', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status } = makeRes();
    await handleThesesSetStatus(makeReq('POST', { status: 'open' }), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
  });

  it('draft→open succeeds with a prediction', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.', predictions: ['Y rises.'] });
    const { res, status, body } = makeRes();
    await handleThesesSetStatus(makeReq('POST', { status: 'open' }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.status).toBe('open');
  });

  it('a manual flip to validated WITHOUT citations returns 400', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.', predictions: ['Y rises.'] });
    await handleThesesSetStatus(makeReq('POST', { status: 'open' }), makeRes().res, { slug: 't1' }, root);
    await handleThesesAddEvidence(makeReq('POST', { verdict: 'supports', source: 'insight' }), makeRes().res, { slug: 't1' }, root);
    const { res, status, body } = makeRes();
    await handleThesesSetStatus(makeReq('POST', { status: 'validated' }), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
    expect(body().error).toBe('status_rejected');
  });

  it('a manual flip to validated WITH a citation returns 200', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.', predictions: ['Y rises.'] });
    await handleThesesSetStatus(makeReq('POST', { status: 'open' }), makeRes().res, { slug: 't1' }, root);
    await handleThesesAddEvidence(makeReq('POST', { verdict: 'supports', source: 'insight' }), makeRes().res, { slug: 't1' }, root);
    const { res, status, body } = makeRes();
    await handleThesesSetStatus(makeReq('POST', { status: 'validated', citations: [0] }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.status).toBe('validated');
  });

  it('force:true (the agent/data-driven path) bypasses the citation gate', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.', predictions: ['Y rises.'] });
    await handleThesesSetStatus(makeReq('POST', { status: 'open' }), makeRes().res, { slug: 't1' }, root);
    const { res, status, body } = makeRes();
    await handleThesesSetStatus(makeReq('POST', { status: 'invalidated', force: true }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.status).toBe('invalidated');
  });

  it('404s for an unknown slug, 400s for an invalid status', async () => {
    {
      const { res, status } = makeRes();
      await handleThesesSetStatus(makeReq('POST', { status: 'open' }), res, { slug: 'nope' }, root);
      expect(status()).toBe(404);
    }
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    {
      const { res, status } = makeRes();
      await handleThesesSetStatus(makeReq('POST', { status: 'bogus' }), res, { slug: 't1' }, root);
      expect(status()).toBe(400);
    }
  });
});

describe('POST /api/theses/:slug/links + DELETE .../links/:kind/:target', () => {
  it('links and unlinks an insight', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    {
      const { res, status, body } = makeRes();
      await handleThesesLink(makeReq('POST', { kind: 'insight', slug: 'wau' }), res, { slug: 't1' }, root);
      expect(status()).toBe(200);
      expect(body().thesis.insights).toEqual(['wau']);
    }
    {
      const { res, status, body } = makeRes();
      await handleThesesUnlink(makeReq('DELETE'), res, { slug: 't1', kind: 'insight', target: 'wau' }, root);
      expect(status()).toBe(200);
      expect(body().thesis.insights).toEqual([]);
    }
  });

  it('400s linking an unknown objective; 400s an invalid kind', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    {
      const { res, status } = makeRes();
      await handleThesesLink(makeReq('POST', { kind: 'objective', slug: 'no-such-objective' }), res, { slug: 't1' }, root);
      expect(status()).toBe(400);
    }
    {
      const { res, status } = makeRes();
      await handleThesesLink(makeReq('POST', { kind: 'bogus', slug: 'x' }), res, { slug: 't1' }, root);
      expect(status()).toBe(400);
    }
  });
});

describe('POST /api/theses/:slug/changelog — understanding changelog', () => {
  it('appends a cycle entry', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesChangelog(makeReq('POST', { text: 'Saw early signal in WAU.', cycle: 3 }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.changelog).toHaveLength(1);
    expect(body().thesis.changelog[0].cycle).toBe(3);
  });

  it('400s on missing text', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status } = makeRes();
    await handleThesesChangelog(makeReq('POST', {}), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
  });
});

describe('POST /api/theses/:slug/promote', () => {
  it('records the promoted knowledge path and retires when asked', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status, body } = makeRes();
    await handleThesesPromote(makeReq('POST', { knowledgePath: 'knowledge/x-improves-y.md', retire: true }), res, { slug: 't1' }, root);
    expect(status()).toBe(200);
    expect(body().thesis.promoted_to).toBe('knowledge/x-improves-y.md');
    expect(body().thesis.status).toBe('retired');
  });

  it('400s on a missing knowledgePath', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    const { res, status } = makeRes();
    await handleThesesPromote(makeReq('POST', {}), res, { slug: 't1' }, root);
    expect(status()).toBe(400);
  });
});

describe('POST /api/learning/enable + /api/learning/disable', () => {
  it('flips learning.enabled on then off, persisted via setup-config', async () => {
    {
      const { res, status, body } = makeRes();
      await handleLearningEnable(makeReq('POST'), res, {}, root);
      expect(status()).toBe(200);
      expect(body().enabled).toBe(true);
      expect(readSetupConfig(projectRoot)?.learning?.enabled).toBe(true);
    }
    {
      const { res, status, body } = makeRes();
      await handleLearningDisable(makeReq('POST'), res, {}, root);
      expect(status()).toBe(200);
      expect(body().enabled).toBe(false);
      expect(readSetupConfig(projectRoot)?.learning?.enabled).toBe(false);
    }
  });
});

describe('roadmap-model — related_theses reverse edges', () => {
  it('attaches theses linked to an objective, sorted by slug', async () => {
    createObjective(root, { slug: 'improve-retention', title: 'Improve retention' });
    createThesis(root, { slug: 'b-thesis', claim: 'B improves retention.', objectives: ['improve-retention'] });
    createThesis(root, { slug: 'a-thesis', claim: 'A improves retention.', objectives: ['improve-retention'] });
    createThesis(root, { slug: 'unlinked', claim: 'Unrelated claim.' });

    const model = buildRoadmapModel(root);
    const objective = model.objectives.find((o) => o.slug === 'improve-retention')!;
    expect(objective.related_theses.map((t) => t.slug)).toEqual(['a-thesis', 'b-thesis']);
    expect(objective.related_theses[0].claim).toBe('A improves retention.');
    expect(objective.related_theses[0].confidence).toBeCloseTo(0.5);
  });

  it('warns (never throws) when a thesis references an unknown objective', async () => {
    createThesis(root, { slug: 't1', claim: 'X improves Y.' });
    // Hand-edit past the store's link-target validation to simulate drift.
    const { readFrontmatter, writeFrontmatter } = await import('../../src/lib/frontmatter.js');
    const path = thesisPath(root, 't1');
    const { data, content } = readFrontmatter(path);
    writeFrontmatter(path, { ...data, objectives: ['ghost-objective'] }, content);

    const model = buildRoadmapModel(root);
    expect(model.warnings.some((w) => w.includes('Thesis "t1"') && w.includes('ghost-objective'))).toBe(true);
  });

  it('tolerates a missing theses/ dir entirely', async () => {
    createObjective(root, { slug: 'goal', title: 'Goal' });
    const model = buildRoadmapModel(root);
    expect(model.objectives.find((o) => o.slug === 'goal')?.related_theses).toEqual([]);
  });
});
