/**
 * Vision pass — tags hook frames with pattern labels.
 *
 * Behind an env-key flag (`OPENAI_VISION_API_KEY` or `GOOGLE_API_KEY`). If
 * neither is set, this is a silent no-op — calling code MUST handle the
 * `provider: null` return from `pickVisionProvider`.
 *
 * YouTube ingest produces no frames (transcript-only) so vision pass is
 * effectively no-op for the existing corpus. Instagram ingest extracts hook
 * frames at t={0,1,2,3}s; those are what get labeled.
 *
 * Cost: ~36 frames per Tilki corpus run × ~$0.0001/frame on gpt-4o-mini =
 * ~$0.004. Negligible. Capped retries (1 attempt per frame) keep tail bounded.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type VisionProvider = 'openai' | 'google';

/**
 * Stable pattern label vocabulary. Vision responses are intersected with this
 * set — anything outside is dropped. Keeps the corpus's pattern_tags clean.
 */
export const LABEL_ALLOWLIST: readonly string[] = [
  'face-zoom',         // close-up face fills majority of frame
  'talking-head',      // person addressing camera, medium shot
  'text-only',         // primarily on-screen text/copy, no person
  'prop-driven',       // physical object central to composition
  'group-shot',        // multiple people
  'environment',       // location/setting establishing shot
  'pattern-interrupt', // visual disruption (motion blur, scale change)
  'b-roll',            // ambient/scenery shot
];

const MAX_LABELS_PER_FRAME = 2;

const PROMPT = `You are a visual-pattern tagger for a marketing creative library.
Look at the attached frame from a paid-ad video. Return ONLY a JSON array of
1-2 labels from this exact vocabulary (lower-case, hyphenated):

${LABEL_ALLOWLIST.join(', ')}

Rules:
- Return ONLY the JSON array. No prose, no code fence, no explanation.
- Pick the SINGLE most defining pattern; add a second only if it's clearly
  also true.
- "talking-head" excludes "face-zoom" — pick the tighter shot if it applies.
- "text-only" requires the dominant visual element to be on-screen text.

Example output: ["face-zoom"]
Example output: ["talking-head","prop-driven"]`;

/**
 * Pick a configured vision provider from env. Returns the first key found.
 * Order: OpenAI (gpt-4o-mini) → Google (gemini-1.5-flash).
 */
export function pickVisionProvider(
  env: NodeJS.ProcessEnv = process.env,
): { provider: VisionProvider; apiKey: string } | null {
  const oai = env.OPENAI_VISION_API_KEY;
  if (oai && oai.trim().length > 0) return { provider: 'openai', apiKey: oai.trim() };
  const goog = env.GOOGLE_API_KEY;
  if (goog && goog.trim().length > 0) return { provider: 'google', apiKey: goog.trim() };
  return null;
}

/**
 * Extract a label array from a vision-model response. Tolerates code fences,
 * leading/trailing prose, and missing brackets. Filters to allowlist. Caps at 2.
 */
export function parseLabelsFromText(
  text: string,
  allowlist: readonly string[] = LABEL_ALLOWLIST,
): string[] {
  if (!text) return [];
  // Strip code fences if the model wrapped them.
  const stripped = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  // Try direct JSON parse first.
  let labels: unknown = null;
  try { labels = JSON.parse(stripped); } catch { /* fall through */ }

  // Try extracting the first [...] array.
  if (!Array.isArray(labels)) {
    const m = stripped.match(/\[([^\]]*)\]/);
    if (m) {
      try { labels = JSON.parse('[' + m[1] + ']'); } catch { /* ignore */ }
    }
  }

  if (!Array.isArray(labels)) return [];

  const allowed = new Set(allowlist);
  const out: string[] = [];
  for (const item of labels) {
    if (typeof item !== 'string') continue;
    const norm = item.trim().toLowerCase();
    if (!allowed.has(norm)) continue;
    if (out.includes(norm)) continue;
    out.push(norm);
    if (out.length >= MAX_LABELS_PER_FRAME) break;
  }
  return out;
}

// ─── HTTP layer (injectable for tests) ──────────────────────────────────────

export interface VisionFetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

const defaultFetcher: VisionFetcher = async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

const REQUEST_TIMEOUT_MS = 30_000;

interface LabelFrameOpts {
  provider: VisionProvider;
  apiKey: string;
  fetcher?: VisionFetcher;
  promptOverride?: string;
}

async function readImageAsBase64(framePath: string): Promise<string> {
  const buf = readFileSync(framePath);
  return buf.toString('base64');
}

/**
 * Call the configured provider on one image. Returns labels intersected with
 * the allowlist. Throws on hard transport failure.
 */
export async function labelHookFrame(
  framePath: string,
  opts: LabelFrameOpts,
): Promise<string[]> {
  if (!existsSync(framePath)) return [];
  const fetcher = opts.fetcher ?? defaultFetcher;
  const prompt = opts.promptOverride ?? PROMPT;
  const b64 = await readImageAsBase64(framePath);

  if (opts.provider === 'openai') {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      }],
    });
    const r = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body,
    });
    if (!r.ok) throw new Error(`openai vision HTTP ${r.status}`);
    const json = JSON.parse(await r.text()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return parseLabelsFromText(text);
  }

  // google
  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/png', data: b64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 60 },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const r = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`google vision HTTP ${r.status}`);
  const json = JSON.parse(await r.text()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return parseLabelsFromText(text);
}

// ─── Post-level pass (file IO + bridge update) ──────────────────────────────

interface PostJsonShape {
  id: string;
  shortcode: string;
  pattern_tags: string[];
  vision_summary: string | null;
  frames: Array<{ timestamp: number; path: string; type: 'hook' | 'regular'; labels?: string[] }>;
  [key: string]: unknown;
}

export interface VisionPassResult {
  shortcode: string;
  framesLabeled: number;
  patternTags: string[];
  skipped: 'no-provider' | 'no-hook-frames' | 'already-labeled' | null;
}

export interface VisionPassOpts {
  apiKey?: string;
  provider?: VisionProvider;
  fetcher?: VisionFetcher;
  /** When true, label even if pattern_tags already populated. Default false. */
  force?: boolean;
}

/**
 * Run vision pass on a single post JSON file. Mutates the file in place.
 *
 * Skips silently when:
 *   - No provider key configured (and none passed via opts).
 *   - No `type: 'hook'` frames present.
 *   - `pattern_tags` already populated and `force` not set.
 */
export async function runVisionPassOnPost(
  postJsonPath: string,
  opts: VisionPassOpts = {},
): Promise<VisionPassResult> {
  const raw = readFileSync(postJsonPath, 'utf-8');
  const post = JSON.parse(raw) as PostJsonShape;
  const shortcode = post.shortcode ?? '?';

  const provider: { provider: VisionProvider; apiKey: string } | null =
    opts.provider && opts.apiKey
      ? { provider: opts.provider, apiKey: opts.apiKey }
      : pickVisionProvider();

  if (!provider) {
    return { shortcode, framesLabeled: 0, patternTags: [], skipped: 'no-provider' };
  }

  const hookFrames = (post.frames ?? []).filter((f) => f.type === 'hook');
  if (hookFrames.length === 0) {
    return { shortcode, framesLabeled: 0, patternTags: [], skipped: 'no-hook-frames' };
  }

  if (post.pattern_tags && post.pattern_tags.length > 0 && !opts.force) {
    return {
      shortcode,
      framesLabeled: 0,
      patternTags: post.pattern_tags,
      skipped: 'already-labeled',
    };
  }

  const aggregated = new Set<string>();
  let framesLabeled = 0;
  for (const fr of hookFrames) {
    let labels: string[] = [];
    try {
      labels = await labelHookFrame(fr.path, {
        provider: provider.provider,
        apiKey: provider.apiKey,
        fetcher: opts.fetcher,
      });
    } catch {
      // Single-frame failure shouldn't abort the post — leave that frame unlabeled.
      continue;
    }
    if (labels.length > 0) framesLabeled += 1;
    fr.labels = labels;
    for (const l of labels) aggregated.add(l);
  }

  post.pattern_tags = [...aggregated].sort();
  post.vision_summary = post.pattern_tags.length > 0
    ? `Vision-tagged ${framesLabeled}/${hookFrames.length} hook frames; patterns: ${post.pattern_tags.join(', ')}.`
    : `Vision pass found no allowlisted patterns across ${hookFrames.length} hook frames.`;

  // Atomic write via tmp + rename.
  const tmp = postJsonPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(post, null, 2) + '\n', 'utf-8');
  const fs = await import('node:fs');
  fs.renameSync(tmp, postJsonPath);

  // Refresh the .md bridge so the readable view stays in sync.
  const mdPath = join(dirname(postJsonPath), `${shortcode}.md`);
  if (existsSync(mdPath)) {
    try {
      const md = readFileSync(mdPath, 'utf-8');
      const refreshed = updatePatternTagsInBridge(md, post.pattern_tags);
      writeFileSync(mdPath, refreshed, 'utf-8');
    } catch {
      // Bridge refresh is best-effort.
    }
  }

  return {
    shortcode,
    framesLabeled,
    patternTags: post.pattern_tags,
    skipped: null,
  };
}

/**
 * Replace or insert `pattern_tags:` line in a competitor-post bridge file
 * frontmatter. Tolerant of missing field.
 */
export function updatePatternTagsInBridge(md: string, tags: string[]): string {
  const tagsLine = `pattern_tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`;
  // Find frontmatter
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return md;
  const fmBody = m[1];
  let newFm: string;
  if (/^pattern_tags:\s*.*$/m.test(fmBody)) {
    newFm = fmBody.replace(/^pattern_tags:\s*.*$/m, tagsLine);
  } else {
    newFm = fmBody.trimEnd() + '\n' + tagsLine;
  }
  return md.replace(m[0], `---\n${newFm}\n---\n`);
}
