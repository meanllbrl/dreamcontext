import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statfsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { MARKETING_PATHS } from './paths.js';
import { isBootstrapped, subprocessEnv } from './bootstrap.js';
import { writeJsonWithBridge, beginRun } from './store.js';

// ─── Health probe ────────────────────────────────────────────────────────────

export interface HealthCheck {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  installHints: string[];
}

interface HealthCacheEntry { at: number; result: HealthCheck; }
let _healthCache: HealthCacheEntry | null = null;
const HEALTH_TTL_MS = 60_000;

function which(cmd: string): string | null {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  if (r.status === 0) return (r.stdout || '').trim().split('\n')[0] || null;
  return null;
}

function diskFreeBytes(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export function health(): HealthCheck {
  if (_healthCache && Date.now() - _healthCache.at < HEALTH_TTL_MS) {
    return _healthCache.result;
  }

  const checks: HealthCheck['checks'] = [];
  const installHints: string[] = [];

  // python3
  const py = which('python3') || which('python');
  checks.push({ name: 'python3', ok: !!py, detail: py ?? undefined });
  if (!py) installHints.push('Install Python 3.10+: macOS `brew install python`, Linux `apt install python3 python3-venv`.');

  // ffmpeg + ffprobe (system deps; cannot be bundled)
  const ffmpeg = which('ffmpeg');
  checks.push({ name: 'ffmpeg', ok: !!ffmpeg, detail: ffmpeg ?? undefined });
  const ffprobe = which('ffprobe');
  checks.push({ name: 'ffprobe', ok: !!ffprobe, detail: ffprobe ?? undefined });
  if (!ffmpeg || !ffprobe) installHints.push('Install ffmpeg: macOS `brew install ffmpeg`, Linux `apt install ffmpeg`.');

  // Bootstrap state
  const bootstrapped = isBootstrapped();
  checks.push({
    name: 'reinfluence-venv',
    ok: bootstrapped,
    detail: bootstrapped ? MARKETING_PATHS.venvDir() : 'not bootstrapped',
  });
  if (!bootstrapped) installHints.push('Run `dreamcontext marketing init` to set up the in-project venv.');

  // Whisper available in venv
  let whisperOk = false;
  if (bootstrapped) {
    const r = spawnSync(MARKETING_PATHS.venvPython(), ['-c', 'import whisper'], { encoding: 'utf8' });
    whisperOk = r.status === 0;
  }
  checks.push({ name: 'whisper', ok: whisperOk });
  if (bootstrapped && !whisperOk) {
    installHints.push('Whisper not importable in venv. Re-run `dreamcontext marketing init`.');
  }

  // Free disk
  const free = bootstrapped ? diskFreeBytes(MARKETING_PATHS.venvDir()) : diskFreeBytes(process.cwd());
  const freeOk = free === null ? true : free > 2 * 1024 * 1024 * 1024;
  checks.push({
    name: 'free-disk',
    ok: freeOk,
    detail: free === null ? 'unknown' : `${(free / 1024 / 1024 / 1024).toFixed(1)} GB`,
  });
  if (!freeOk) installHints.push('Free at least 2 GB before ingesting (Whisper models + video frames).');

  const result: HealthCheck = {
    ok: checks.every((c) => c.ok),
    checks,
    installHints,
  };
  _healthCache = { at: Date.now(), result };
  return result;
}

export function clearHealthCache(): void { _healthCache = null; }

// ─── Concurrency cap (in-process, single ingest) ─────────────────────────────

let _ingestInFlight = false;

export class IngestBusyError extends Error {
  constructor() {
    super('Another competitor ingest is already running in this process. Concurrent ingests are capped at 1.');
    this.name = 'IngestBusyError';
  }
}

// ─── Event types from python -m reinfluence ──────────────────────────────────

export type IngestEvent =
  | { event: 'start'; kind: string; input: string }
  | { event: 'post'; handle: string; shortcode: string; url: string;
      caption: string | null; duration_seconds: number | null;
      video_path: string; thumbnail_url: string | null;
      transcript: { text: string; language: string | null;
        segments: Array<{ start: number; end: number; text: string }>;
        model: string; } | null;
      frames: Array<{ timestamp: number; path: string; type: 'hook' | 'regular' }>; }
  | { event: 'warn'; message: string }
  | { event: 'error'; message: string }
  | { event: 'done'; posts: number };

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestOptions {
  target: string;             // URL or IG handle
  model?: string;             // Whisper model (default: medium)
  max?: number;               // For profile ingest, max posts (0 = all)
  skipTranscripts?: boolean;
  skipFrames?: boolean;
  /** Wall-clock kill (ms). Default 600s. */
  timeoutMs?: number;
}

export interface IngestSummary {
  runId: string;
  postsIngested: number;
  warnings: string[];
  errors: string[];
}

export async function ingestCompetitor(opts: IngestOptions): Promise<IngestSummary> {
  if (_ingestInFlight) throw new IngestBusyError();
  _ingestInFlight = true;

  const h = health();
  if (!h.ok) {
    _ingestInFlight = false;
    const failed = h.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
    throw new Error(`Health check failed: ${failed}\n${h.installHints.join('\n')}`);
  }

  const run = beginRun('competitor-ingest', {
    target: opts.target,
    model: opts.model ?? 'medium',
    max: opts.max ?? 0,
    skip_transcripts: !!opts.skipTranscripts,
    skip_frames: !!opts.skipFrames,
  });

  // Out-dir for binary outputs (videos/frames). Lives under competitors/ but
  // each post is normalized later.
  const outDir = join(MARKETING_PATHS.competitorsDir(), '_ingest-tmp', run.id);
  mkdirSync(outDir, { recursive: true });

  const args = [
    '-m', 'reinfluence', 'ingest', opts.target,
    '--out-dir', outDir,
    '--model', opts.model ?? 'medium',
    '--max', String(opts.max ?? 0),
  ];
  if (opts.skipTranscripts) args.push('--skip-transcripts');
  if (opts.skipFrames) args.push('--skip-frames');

  const warnings: string[] = [];
  const errors: string[] = [];
  let postsIngested = 0;

  try {
    await new Promise<void>((resolveP, rejectP) => {
      const proc = spawn(MARKETING_PATHS.venvPython(), args, {
        env: subprocessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeoutMs = opts.timeoutMs ?? 600_000;
      const killer = setTimeout(() => {
        proc.kill('SIGKILL');
        rejectP(new Error(`ingest exceeded ${timeoutMs}ms wall-clock — killed`));
      }, timeoutMs);

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let evt: IngestEvent;
          try {
            evt = JSON.parse(line) as IngestEvent;
          } catch {
            warnings.push(`unparseable line: ${line.slice(0, 200)}`);
            continue;
          }
          run.appendEvent(evt as Record<string, unknown>);
          if (evt.event === 'post') {
            try {
              persistPost(evt);
              postsIngested++;
            } catch (e) {
              errors.push(`persist failed for ${evt.shortcode}: ${(e as Error).message}`);
            }
          } else if (evt.event === 'warn') {
            warnings.push(evt.message);
          } else if (evt.event === 'error') {
            errors.push(evt.message);
          }
        }
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        if (stderrBuf.length > 16_000) stderrBuf = stderrBuf.slice(-16_000);
      });

      proc.on('error', (e) => {
        clearTimeout(killer);
        rejectP(e);
      });

      proc.on('exit', (code) => {
        clearTimeout(killer);
        if (code === 0) {
          resolveP();
        } else {
          rejectP(new Error(`reinfluence exited code ${code}\nstderr: ${stderrBuf.slice(0, 1000)}`));
        }
      });
    });

    run.succeed({ posts_ingested: postsIngested, warnings: warnings.length, errors: errors.length });
  } catch (e) {
    run.fail((e as Error).message);
    throw e;
  } finally {
    _ingestInFlight = false;
  }

  return { runId: run.id, postsIngested, warnings, errors };
}

// ─── Post persistence ────────────────────────────────────────────────────────

interface PostJson {
  id: string;
  type: 'competitor_post';
  handle: string;
  shortcode: string;
  url: string;
  caption: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  transcript: PostEvent['transcript'];
  frames: PostEvent['frames'];
  pattern_tags: string[];
  vision_summary: string | null;
  ingested_at: string;
  asset_paths: { video: string | null; frames: string[] };
}

type PostEvent = Extract<IngestEvent, { event: 'post' }>;

function persistPost(evt: PostEvent): void {
  const handleDir = join(MARKETING_PATHS.competitorsDir(), evt.handle);
  const postsDir = join(handleDir, 'posts');
  const mediaDir = join(handleDir, '_media', evt.shortcode);
  mkdirSync(postsDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  // Move video + frames from _ingest-tmp to handle/_media/<shortcode>/
  const finalVideoPath = evt.video_path
    ? moveAsset(evt.video_path, join(mediaDir, basename(evt.video_path)))
    : null;
  const finalFramePaths: string[] = [];
  for (const fr of evt.frames) {
    const finalP = moveAsset(fr.path, join(mediaDir, 'frames', basename(fr.path)));
    finalFramePaths.push(finalP);
  }

  const id = `${evt.handle}__${evt.shortcode}`;
  const json: PostJson = {
    id,
    type: 'competitor_post',
    handle: evt.handle,
    shortcode: evt.shortcode,
    url: evt.url,
    caption: evt.caption,
    duration_seconds: evt.duration_seconds,
    thumbnail_url: evt.thumbnail_url,
    transcript: evt.transcript,
    frames: evt.frames.map((fr, i) => ({ ...fr, path: finalFramePaths[i] ?? fr.path })),
    pattern_tags: [],
    vision_summary: null,
    ingested_at: new Date().toISOString(),
    asset_paths: { video: finalVideoPath, frames: finalFramePaths },
  };

  const jsonPath = join(postsDir, `${evt.shortcode}.json`);
  const bridgePath = join(postsDir, `${evt.shortcode}.md`);
  writeJsonWithBridge(jsonPath, bridgePath, json, renderPostBridge(json));

  // Ensure handle/meta.json
  const metaPath = join(handleDir, 'meta.json');
  if (!existsSync(metaPath)) {
    writeJsonWithBridge(
      metaPath,
      join(handleDir, 'meta.md'),
      { handle: evt.handle, first_seen_at: new Date().toISOString() },
      `---\nid: competitor_${evt.handle}\ntype: competitor_meta\nhandle: ${evt.handle}\n---\n\n# @${evt.handle}\n\nFirst seen: ${new Date().toISOString()}\n`,
    );
  }
}

function moveAsset(src: string, dest: string): string {
  if (!existsSync(src)) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  // Use cpSync + unlinkSync for cross-device safety; rename can fail across mounts.
  // Lazy-import fs to keep this file lean.
  const fs = require('node:fs') as typeof import('node:fs');
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.cpSync(src, dest);
    try { fs.unlinkSync(src); } catch { /* ignore */ }
  }
  return dest;
}

function renderPostBridge(p: PostJson): string {
  const transcriptSnippet = p.transcript?.text
    ? p.transcript.text.slice(0, 280) + (p.transcript.text.length > 280 ? '…' : '')
    : '_(no transcript)_';
  const links: string[] = [`[[../meta|@${p.handle}]]`];
  return [
    '---',
    `id: ${p.id}`,
    `type: competitor_post`,
    `handle: ${p.handle}`,
    `shortcode: ${p.shortcode}`,
    `url: ${p.url}`,
    `duration_seconds: ${p.duration_seconds ?? 'null'}`,
    `ingested_at: ${p.ingested_at}`,
    `frames_count: ${p.frames.length}`,
    `links: [${links.join(', ')}]`,
    '---',
    '',
    `# @${p.handle} — ${p.shortcode}`,
    '',
    `**URL:** ${p.url}`,
    `**Duration:** ${p.duration_seconds ?? '?'}s · **Frames:** ${p.frames.length} · **Transcript:** ${p.transcript ? 'yes' : 'no'}`,
    '',
    '## Transcript',
    '',
    transcriptSnippet,
    '',
  ].join('\n');
}

// Path helper for normalizer tests
export function postOutputPaths(handle: string, shortcode: string): {
  json: string; md: string; mediaDir: string;
} {
  const handleDir = join(MARKETING_PATHS.competitorsDir(), handle);
  return {
    json: join(handleDir, 'posts', `${shortcode}.json`),
    md: join(handleDir, 'posts', `${shortcode}.md`),
    mediaDir: join(handleDir, '_media', shortcode),
  };
}
// keep type-only imports happy
export type { PostJson };
// silence unused
void extname;
