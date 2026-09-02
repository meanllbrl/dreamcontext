/**
 * Report commentary — the OPTIONAL agent-written reading layer (owner,
 * 2026-09-01: button-triggered, never scheduled by default; `commentary: false`
 * makes a report AI-free and first-class). The generation is a pure text
 * transform: the model writes prose, the SERVER writes the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createInsight, cachePath } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { createReport, getReport, reportPath, resolveReport } from '../../src/lib/lab/reports-store.js';
import {
  MAX_COMMENTARY_BYTES,
  buildCommentaryPrompt,
  commentaryPath,
  generateReportCommentary,
  readReportCommentary,
  writeReportCommentary,
} from '../../src/lib/lab/report-commentary.js';
import {
  _resetLabCommentaryJobs,
  currentLabCommentaryJob,
  startLabCommentaryJob,
} from '../../src/server/lab-commentary-job.js';
import {
  handleLabReportCommentaryGet,
  handleLabReportCommentaryStart,
} from '../../src/server/routes/lab.js';
import { LabError } from '../../src/lib/lab/types.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-commentary-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  seededInsight = false;
  _resetLabCommentaryJobs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DREAMCONTEXT_CLAUDE_BIN;
  vi.restoreAllMocks();
});

let seededInsight = false;

/** Seed a report over one synced insight. `window: own` by default so the
 *  live view reads the canonical cache (commentary is generated AFTER the
 *  page's window syncs settle — the tests exercise the text layer). */
async function seedReport(slug = 'weekly', extraFrontmatter = 'window: own'): Promise<void> {
  if (!seededInsight) {
    createInsight(root, { slug: 'spend', title: 'Ad Spend', adapter: 'script' });
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'scripts', 'spend.mjs'),
      `export default async () => ([{ name: 'spend', points: [{ t: '2026-08-31', v: 1276.75 }] }]);`,
      'utf-8',
    );
    await syncInsight(root, 'spend', { force: true });
    seededInsight = true;
  }
  createReport(root, { slug, title: 'Weekly', description: 'The week.', insights: ['spend'] });
  if (extraFrontmatter) {
    const path = reportPath(root, slug);
    writeFileSync(path, readFileSync(path, 'utf-8').replace('date_nav: daily', `date_nav: daily\n${extraFrontmatter}`), 'utf-8');
  }
}

describe('commentary store', () => {
  it('round-trips a dated commentary; missing/blank reads as null', () => {
    writeReportCommentary(root, {
      slug: 'weekly', dateKey: '2026-08-25', generatedAt: '2026-09-01T10:00:00Z', model: 'sonnet', body: '**Okuma:** iyi hafta.',
    });
    const read = readReportCommentary(root, 'weekly', '2026-08-25');
    expect(read).not.toBeNull();
    expect(read!.body).toBe('**Okuma:** iyi hafta.');
    expect(read!.model).toBe('sonnet');
    expect(readReportCommentary(root, 'weekly', 'live')).toBeNull();
    expect(readReportCommentary(root, '../evil', 'live')).toBeNull(); // path-safe
  });
});

describe('prompt honesty', () => {
  it('embeds the real numbers, windows and honest states — and the hard rules', async () => {
    await seedReport();
    const report = getReport(root, 'weekly')!;
    const sections = resolveReport(root, report, null);
    const prompt = buildCommentaryPrompt(report, sections, null, null);
    expect(prompt).toContain('NEVER invent');
    expect(prompt).toContain('LANGUAGE the report itself is written in');
    // The spread contract: overall reading first, then `## <section title>`
    // blocks parsed mechanically — titles listed verbatim.
    expect(prompt).toContain('OUTPUT FORMAT');
    expect(prompt).toContain('the section title EXACTLY as listed');
    expect(prompt).toContain('Section titles, exactly: "Overview"');
    expect(prompt).toContain('1276.75');
    expect(prompt).toMatch(/NOT MEASURED YET|window/); // window state is in front of the model
    expect(prompt).toContain('REPORT: Weekly');
  });

  it('carries the previous commentary for continuity', async () => {
    await seedReport();
    const report = getReport(root, 'weekly')!;
    writeReportCommentary(root, {
      slug: 'weekly', dateKey: 'live', generatedAt: 'x', model: 'sonnet', body: 'Geçen okuma.',
    });
    const prior = readReportCommentary(root, 'weekly', 'live');
    const prompt = buildCommentaryPrompt(report, resolveReport(root, report, null), null, prior);
    expect(prompt).toContain('PREVIOUS COMMENTARY');
    expect(prompt).toContain('Geçen okuma.');
  });
});

describe('generateReportCommentary', () => {
  it('writes the dated file from the run output (server writes, model only talks)', async () => {
    await seedReport();
    const report = getReport(root, 'weekly')!;
    const sections = resolveReport(root, report, null);
    const commentary = await generateReportCommentary(root, report, sections, null, {
      runImpl: async (prompt) => {
        expect(prompt).toContain('1276.75');
        return '**Okuma:** harcama sabit.';
      },
    });
    expect(commentary.dateKey).toBe('live');
    expect(readFileSync(commentaryPath(root, 'weekly', 'live'), 'utf-8')).toContain('harcama sabit');
  });

  it('caps oversized output and rejects empty output', async () => {
    await seedReport();
    const report = getReport(root, 'weekly')!;
    const sections = resolveReport(root, report, null);
    const big = await generateReportCommentary(root, report, sections, null, {
      runImpl: async () => 'x'.repeat(MAX_COMMENTARY_BYTES + 500),
    });
    expect(Buffer.byteLength(big.body, 'utf-8')).toBeLessThanOrEqual(MAX_COMMENTARY_BYTES + 4);
    await expect(generateReportCommentary(root, report, sections, null, {
      runImpl: async () => '   ',
    })).rejects.toThrow(LabError);
  });

  it('refuses when the report opted out (commentary: false — non-AI reports are first-class)', async () => {
    await seedReport('quiet', 'window: own\ncommentary: false');
    const report = getReport(root, 'quiet')!;
    expect(report.commentary).toBe(false);
    await expect(generateReportCommentary(root, report, [], null, {
      runImpl: async () => 'never',
    })).rejects.toThrow(/disabled/);
  });
});

// ─── Route + job layer ───────────────────────────────────────────────────────

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

function makeReq(url: string, body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(readable, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    url,
  }) as unknown as IncomingMessage;
}

/** A fake `claude` binary that echoes a canned reading. */
function installFakeClaude(): void {
  const bin = join(root, 'fake-claude');
  writeFileSync(bin, '#!/bin/sh\necho "**Okuma:** sahte model konustu."\n', 'utf-8');
  chmodSync(bin, 0o755);
  process.env.DREAMCONTEXT_CLAUDE_BIN = bin;
}

async function settled(slug: string, date: string | null) {
  for (let i = 0; i < 200; i++) {
    const job = currentLabCommentaryJob(root, slug, date);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('commentary job never settled');
}

describe('commentary routes + job', () => {
  it('POST starts (then adopts) a generation through the real headless spawn path', async () => {
    await seedReport();
    installFakeClaude();
    const first = makeRes();
    await handleLabReportCommentaryStart(makeReq('/api/lab/reports/weekly/commentary', {}), first.res, { slug: 'weekly' }, root);
    expect(first.status()).toBe(200);
    expect(first.body().started).toBe(true);

    const job = await settled('weekly', null);
    expect(job.status).toBe('success');
    expect(job.commentary?.body).toContain('sahte model konustu');

    const get = makeRes();
    await handleLabReportCommentaryGet(makeReq('/api/lab/reports/weekly/commentary'), get.res, { slug: 'weekly' }, root);
    expect(get.status()).toBe(200);
    expect(get.body().commentary.body).toContain('sahte model konustu');
  });

  it('404 unknown report, 409 when disabled, 400 bad date', async () => {
    await seedReport('quiet', 'window: own\ncommentary: false');
    const missing = makeRes();
    await handleLabReportCommentaryStart(makeReq('/api/lab/reports/nope/commentary', {}), missing.res, { slug: 'nope' }, root);
    expect(missing.status()).toBe(404);

    const disabled = makeRes();
    await handleLabReportCommentaryStart(makeReq('/api/lab/reports/quiet/commentary', {}), disabled.res, { slug: 'quiet' }, root);
    expect(disabled.status()).toBe(409);

    await seedReport('dated');
    const badDate = makeRes();
    await handleLabReportCommentaryStart(makeReq('/api/lab/reports/dated/commentary', { date: 'yesterday' }), badDate.res, { slug: 'dated' }, root);
    expect(badDate.status()).toBe(400);
  });

  it('a failing run settles the job as error — nothing is written', async () => {
    await seedReport();
    const bin = join(root, 'fake-claude-fail');
    writeFileSync(bin, '#!/bin/sh\necho "boom" >&2\nexit 1\n', 'utf-8');
    chmodSync(bin, 0o755);
    process.env.DREAMCONTEXT_CLAUDE_BIN = bin;
    startLabCommentaryJob(root, 'weekly', null);
    const job = await settled('weekly', null);
    expect(job.status).toBe('error');
    expect(job.error).toContain('boom');
    expect(readReportCommentary(root, 'weekly', 'live')).toBeNull();
  });
});
