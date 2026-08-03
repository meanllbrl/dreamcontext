#!/usr/bin/env node
/**
 * PDF in the app + the two ways out to the OS — end-to-end verification of the SERVER half.
 *
 *   npm run build && npm run verify:pdf-viewer
 *
 * The viewer is an `<iframe>` around one URL, so everything that decides whether a PDF opens
 * in the app is on this side of the wire. Proves, against the real dashboard server booted on
 * an isolated scratch vault (no user state touched, no tokens spent):
 *
 *   1. `GET /agent/file?path=…pdf&raw=1` answers `application/pdf`, inline, nosniff — the
 *      exact response the viewer embeds;
 *   2. it is RANGE-served (206 + Content-Range), which is how an engine's PDF viewer pages a
 *      large document in rather than stalling on the first byte;
 *   3. the old failure is gone: the same file used to reach only the JSON text branch, which
 *      for anything of a normal size answers 413 `too_large`;
 *   4. a PDF outside the project still needs consent (403 `needs_grant`) — the new type does
 *      not widen what the route will serve;
 *   5. `POST /agent/reveal` honours `mode`: `reveal` SHOWS a file it would otherwise open,
 *      the default still opens a PDF, and no mode can make it launch a `.sh`;
 *   6. a PDF a KNOWLEDGE note links to opens through the vault route instead
 *      (`GET /graph/content?path=…&raw=1`) — same content type, inline, ranged — and that
 *      route stays contained to the vault and unchanged for every existing caller.
 *
 * Same harness contract as the other verify scripts: real server, isolated fake HOME,
 * COLLECT-DON'T-FAIL-FAST reporting.
 *
 * NOTE: check 5 exercises the OS opener for real — it is the only way to prove the route
 * actually hands a path over — so running this pops your PDF viewer and a file-manager window
 * on the scratch files. That is the behaviour under test, not a bug in the script.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), 'dreamcontext-verify-pdf');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OUTSIDE = join(SCRATCH, 'elsewhere');

/** A small but structurally real PDF, and — the point of the padding — one comfortably over
 *  the 512KB text-preview cap, which is what the old path died on. */
function pdfBytes(padTo = 0) {
  const head = '%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n';
  const tail = '\ntrailer<</Root 1 0 R>>\n%%EOF\n';
  const pad = padTo > head.length + tail.length ? 'x'.repeat(padTo - head.length - tail.length) : '';
  return Buffer.from(head + pad + tail, 'utf-8');
}

function setup() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(PROJ, 'docs'), { recursive: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });

  const init = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'init', '--yes'],
    { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

  writeFileSync(join(PROJ, 'docs', 'handbook.pdf'), pdfBytes(700 * 1024));
  writeFileSync(join(PROJ, 'docs', 'tiny.pdf'), pdfBytes());
  writeFileSync(join(PROJ, 'docs', 'install.sh'), '#!/bin/sh\necho hi\n', 'utf-8');
  writeFileSync(join(OUTSIDE, 'contract.pdf'), pdfBytes());

  // The knowledge half: a note, and beside it the document it was distilled from — the shape
  // the owner named ("a PDF can land in Knowledge too"). Written straight into the vault
  // rather than through the CLI because `knowledge create` writes markdown, and the file
  // under test is deliberately not markdown.
  const KDIR = join(PROJ, '_dream_context', 'knowledge', 'legal');
  mkdirSync(join(KDIR, 'assets'), { recursive: true });
  writeFileSync(join(KDIR, 'assets', 'msa.pdf'), pdfBytes(300 * 1024));
  writeFileSync(join(KDIR, 'contracts.md'),
    '---\ntype: knowledge\nname: contracts\n---\n\n# Contracts\n\nSee [the MSA](assets/msa.pdf).\n', 'utf-8');

  const add = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    // The whole surface is desktop-gated; without this every route below answers 403 and the
    // run would "pass" by never reaching anything.
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return srv;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── reporting ────────────────────────────────────────────────────────────────────────

const results = [];
const check = (label, cond, detail) => {
  results.push({ label, ok: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond || !detail ? '' : `  — ${detail}`}`);
};

// ─── the assertions ───────────────────────────────────────────────────────────────────

async function run(base) {
  const fileUrl = (p, raw = true) =>
    `${base}/api/agent/file?path=${encodeURIComponent(p)}${raw ? '&raw=1' : ''}`;

  // 1 — the response the viewer embeds
  {
    const r = await fetch(fileUrl('docs/handbook.pdf'));
    const body = Buffer.from(await r.arrayBuffer());
    check('raw PDF is 200 application/pdf', r.status === 200 && r.headers.get('content-type') === 'application/pdf',
      `${r.status} ${r.headers.get('content-type')}`);
    check('served inline, never as a download', r.headers.get('content-disposition') === 'inline',
      String(r.headers.get('content-disposition')));
    check('nosniff rides the response', r.headers.get('x-content-type-options') === 'nosniff');
    check('advertises byte ranges', r.headers.get('accept-ranges') === 'bytes');
    check('bytes round-trip verbatim', body.subarray(0, 8).toString() === '%PDF-1.7', body.subarray(0, 8).toString());
    check('a 700KB document comes back WHOLE (no preview cap on the raw path)',
      body.length === 700 * 1024, `${body.length} bytes`);
  }

  // 2 — ranges: how a viewer pages a document in
  {
    const r = await fetch(fileUrl('docs/handbook.pdf'), { headers: { Range: 'bytes=0-15' } });
    const body = Buffer.from(await r.arrayBuffer());
    check('a range request answers 206', r.status === 206, String(r.status));
    check('Content-Range names the window and the real size',
      r.headers.get('content-range') === `bytes 0-15/${700 * 1024}`, String(r.headers.get('content-range')));
    check('only the asked-for bytes come back', body.length === 16, `${body.length} bytes`);
  }

  // 3 — the failure this feature exists to remove
  {
    const r = await fetch(fileUrl('docs/handbook.pdf', false));
    const body = await r.json().catch(() => null);
    check('WITHOUT raw=1 the same file still hits the text cap — the old dead end',
      r.status === 413 && body?.error === 'too_large', `${r.status} ${body?.error}`);
  }

  // 4 — the new type does not widen the route
  {
    const r = await fetch(fileUrl(join(OUTSIDE, 'contract.pdf')));
    const body = await r.json().catch(() => null);
    check('a PDF outside the project is still refused pending consent',
      r.status === 403 && body?.error === 'needs_grant', `${r.status} ${body?.error}`);
    check('the refusal names the RESOLVED file, so a grant can record it',
      body?.path === join(OUTSIDE, 'contract.pdf'), String(body?.path));
  }

  // 5 — the two buttons
  const reveal = async (path, mode) => {
    const r = await fetch(`${base}/api/agent/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === undefined ? { path } : { path, mode }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  {
    const opened = await reveal(join(PROJ, 'docs', 'tiny.pdf'));
    check('"Open on computer" on a PDF opens it', opened.status === 200 && opened.body?.mode === 'open',
      `${opened.status} ${opened.body?.mode}`);

    const shown = await reveal(join(PROJ, 'docs', 'tiny.pdf'), 'reveal');
    check('"Reveal in Finder" SHOWS the same file instead of opening it',
      shown.status === 200 && shown.body?.mode === 'reveal', `${shown.status} ${shown.body?.mode}`);

    const script = await reveal(join(PROJ, 'docs', 'install.sh'));
    check('a .sh is still never launched, whatever the button said',
      script.status === 200 && script.body?.mode === 'reveal', `${script.status} ${script.body?.mode}`);

    const odd = await reveal(join(PROJ, 'docs', 'install.sh'), 'open');
    check('and asking for "open" cannot unlock it', odd.body?.mode === 'reveal', String(odd.body?.mode));

    const gone = await reveal(join(PROJ, 'docs', 'nope.pdf'));
    check('a file that is not there answers 404 rather than opening nothing in silence',
      gone.status === 404, String(gone.status));
  }

  // 6 — the knowledge half. A note's link resolves to a VAULT path, and the bytes come from
  //     the vault route: the Knowledge page is not desktop-only, so routing it through
  //     /agent/file would answer "desktop only" to a browser dashboard reading its own vault.
  const vaultUrl = (p, raw = true) =>
    `${base}/api/graph/content?path=${encodeURIComponent(p)}${raw ? '&raw=1' : ''}`;
  {
    const MSA = 'knowledge/legal/assets/msa.pdf';
    const r = await fetch(vaultUrl(MSA));
    const body = Buffer.from(await r.arrayBuffer());
    check('a knowledge PDF is 200 application/pdf from the vault route',
      r.status === 200 && r.headers.get('content-type') === 'application/pdf',
      `${r.status} ${r.headers.get('content-type')}`);
    check('served inline, nosniff, range-capable',
      r.headers.get('content-disposition') === 'inline'
      && r.headers.get('x-content-type-options') === 'nosniff'
      && r.headers.get('accept-ranges') === 'bytes');
    check('the whole 300KB document comes back', body.length === 300 * 1024, `${body.length} bytes`);

    const ranged = await fetch(vaultUrl(MSA), { headers: { Range: 'bytes=0-15' } });
    check('and it is ranged, so the engine can page it in',
      ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 16, String(ranged.status));

    // The note that links it still reads as markdown — the arm is an opt-in on one type, not
    // a mode switch that changes what every other caller of this route gets.
    const note = await fetch(vaultUrl('knowledge/legal/contracts.md', false));
    const noteBody = await note.json().catch(() => null);
    check('the note itself still answers the JSON preview, unchanged',
      note.status === 200 && noteBody?.type === 'markdown', `${note.status} ${noteBody?.type}`);

    const txt = await fetch(vaultUrl('knowledge/legal/contracts.md'));
    const txtBody = await txt.json().catch(() => null);
    check('raw=1 on a type not on the allowlist falls through to the old answer',
      txt.status === 200 && txtBody?.type === 'markdown', `${txt.status} ${txtBody?.type}`);

    const escape = await fetch(vaultUrl('../../docs/handbook.pdf'));
    check('the vault route cannot be walked out of, even for an allowlisted type',
      escape.status === 400, String(escape.status));

    const missing = await fetch(vaultUrl('knowledge/legal/assets/nope.pdf'));
    check('a knowledge PDF that is not there answers 404', missing.status === 404, String(missing.status));
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────────────

let server = null;
try {
  console.log('· preparing an isolated scratch vault…');
  setup();
  const port = await freePort();
  console.log(`· starting the real dashboard server on ${port}…`);
  server = await startServer(port);
  console.log('· asserting:');
  await run(`http://127.0.0.1:${port}`);
} finally {
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
