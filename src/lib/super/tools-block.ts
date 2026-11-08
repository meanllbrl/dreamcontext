import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { refreshCodexHealth } from '../codex-bin.js';
import { BASE_MODEL_OPTIONS, modelOptionsFrom, type ModelOption } from '../model-list.js';
import { listTools, type ToolId, type ToolInfo, type ToolLookup } from '../t3-bridge/registry.js';

/**
 * THE TOOLS ON THIS MAC, AS THE SUPER AGENT SEES THEM (task super-agent-bu-mac-teki-araclari-…).
 * The owner asked his Super Agent to "run a Gemini model" and it did not know Antigravity was
 * Gemini, nor that `super delegate --tool` existed. This block tells it, live, every turn it
 * changed: which of Claude, Codex and Antigravity can start a child right now, the models each
 * takes, and the one flag that picks them.
 *
 * ONE source each, never a list of our own: readiness and the Codex / Antigravity models are
 * `listTools()` (what `/api/agent/tools` and the model picker read); Claude's models are
 * `modelOptionsFrom` (what `/api/agent/model-config` reads). Rides like the AI Team block: in the
 * spawn's system prompt, then as `<super-tools fp=…>` on an owner message when it changed.
 */

/** The header line; its fingerprint is what an owner turn compares. */
export const toolsBlockHeader = (fp: string): string => `## Tools on this Mac <!-- fp=${fp} -->`;
const HEADER_RE = /^## Tools on this Mac <!-- fp=([0-9a-f]{12}) -->/;
export const SUPER_TOOLS_TAG_RE = /^<super-tools fp=([0-9a-f]{12})>/;

/** Models named per tool before the rest are counted (the block rides a snapshot budget). */
const MAX_MODELS = 8;

/** What the owner calls each tool, in his words: the Super maps these, never refuses them. */
const VENDOR_WORDS: Record<ToolId, string> = {
  claude: 'Claude, Anthropic, Opus, Sonnet, Haiku, Fable',
  codex: 'GPT, OpenAI, ChatGPT, Codex',
  antigravity: 'Gemini, Google, Antigravity',
};

/** One line on what the owner must do before a tool can run a child. */
export function notReadyFix(t: ToolInfo): string {
  if (!t.installed) return `not installed: the owner installs ${t.label} from the model picker (Settings > Models)`;
  if (t.runs === false) return `installed but does not start: the owner reinstalls ${t.label} from Settings > Models`;
  if (t.outdated) return `too old: the owner updates ${t.label} from Settings > Models`;
  if (!t.signedIn) return `signed out: the owner signs in to ${t.label} from the model picker (Settings > Models)`;
  if (!t.nodeOk) return `needs a newer Node on this Mac: the owner updates it from Settings > Models`;
  return 'not ready: the owner opens Settings > Models';
}

function modelList(ids: readonly string[], dflt: string | null): string {
  const shown = ids.slice(0, MAX_MODELS).map((id) => (id === dflt ? `${id} (default)` : id));
  const rest = ids.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`;
}

/** One tool's line: ready with its models, or what the owner must do. */
function toolLine(t: ToolInfo, claudeModels: readonly ModelOption[]): string {
  const name = `\`${t.tool}\` (${VENDOR_WORDS[t.tool]})`;
  if (!t.ready) return `- ${name}: ${notReadyFix(t)}. Do not start a child on it.`;
  if (t.tool === 'claude') {
    return `- ${name}: ready. Models: ${modelList(claudeModels.map((m) => m.id), null)}; no --model = the owner's default. --effort low|medium|high|xhigh|max.`;
  }
  const ids = t.models.map((m) => m.id);
  const efforts = [...new Set(t.models.flatMap((m) => m.efforts))];
  const effort = t.tool === 'antigravity'
    ? 'the model id carries its effort (-high, -medium, -low); no --effort.'
    : efforts.length ? `--effort ${efforts.join('|')}.` : '';
  const models = ids.length ? `Models: ${modelList(ids, t.defaultModel)}; no --model = the default.` : 'Its own default model only: no --model.';
  return `- ${name}: ready. ${models} ${effort}`.trimEnd();
}

/**
 * The block, from what the registry and the Claude list say. Pure: the tests drive it with any
 * readiness. Only READY tools are offered; a tool that is not ready says what the owner must do.
 */
export function renderToolsBlock(tools: readonly ToolInfo[], claudeModels: readonly ModelOption[] = BASE_MODEL_OPTIONS): string {
  const body = [
    'Each child runs on one tool. Start one with `dreamcontext super delegate --tool <tool> --model <id> --prompt \'…\'`',
    '(`super pool add` takes the same flags). AI Team members (`super team ask`) run on Claude.',
    'Map the owner\'s words: "Gemini" or Google = antigravity, "GPT", OpenAI or ChatGPT = codex, Opus/Sonnet/Haiku = claude.',
    'A model he names is matched to the closest id below (family, version, size, high/medium/low), never refused; none',
    'close: tell him which ones this Mac has. A tool that is not ready: tell him the one step, never start it there.',
    ...tools.map((t) => toolLine(t, claudeModels)),
  ].join('\n');
  const fp = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return `${toolsBlockHeader(fp)}\n${body}`;
}

/** The fingerprint a block's own header carries, or null. */
export function toolsBlockFingerprint(block: string): string | null {
  const m = HEADER_RE.exec(block);
  return m ? m[1]! : null;
}

// ─── Live reads ───────────────────────────────────────────────────────────────────────

/** Claude's models as the picker last read them (`~/.claude.json`); the base aliases until then. */
let claudeModelsCache: ModelOption[] | null = null;

/** The last block `refreshSuperTools` rendered: what a turn reads, so a turn never runs a tool. */
let blockCache: string | null = null;
/** A model id that may ride the Super's prompt: one token, never a line of text. */
const SAFE_ID = /^[A-Za-z0-9._[\]-]{1,64}$/;

/**
 * Re-read and re-render off the turn's path: `codex --version` once per binary (codex-bin's
 * memory, filled here asynchronously, so the render below spawns nothing) and Claude's cached
 * model list. Never throws.
 */
export async function refreshSuperTools(home: string = homedir()): Promise<void> {
  try { await refreshCodexHealth(); } catch { /* the render below asks again */ }
  try {
    const raw = await readFile(join(home, '.claude.json'), 'utf-8');
    claudeModelsCache = modelOptionsFrom(JSON.parse(raw) as Record<string, unknown>).filter((m) => SAFE_ID.test(m.id));
  } catch { /* keep what we had */ }
  const next = liveToolsBlock();
  if (next) blockCache = next;
}

/** The block as this Mac stands now ('' only when the registry itself cannot be read). May run
 *  `codex --version` synchronously on a cold memory: a turn reads {@link toolsBlockNow} instead. */
export function liveToolsBlock(o: ToolLookup = {}): string {
  try { return renderToolsBlock(listTools(o), claudeModelsCache ?? BASE_MODEL_OPTIONS); } catch { return ''; }
}

/** The block a spawn or an owner turn carries: the last refreshed one; read live only before the
 *  first refresh ever finished (a server's first Super spawn). */
export function toolsBlockNow(): string {
  if (blockCache === null) blockCache = liveToolsBlock() || null;
  return blockCache ?? '';
}

/**
 * The owner message's `<super-tools>` block when the tools changed since the Super last saw them
 * (`delivered`), else nothing. A `/` command carries none. `delivered` is what it holds after.
 */
export function superOwnerToolsBlock(i: { text: string; block: string; delivered: string | null }): { block: string | null; delivered: string | null } {
  if (i.text.startsWith('/') || !i.block) return { block: null, delivered: i.delivered };
  const fp = toolsBlockFingerprint(i.block);
  if (!fp || fp === i.delivered) return { block: null, delivered: i.delivered };
  return { block: `<super-tools fp=${fp}>\n${i.block}\n</super-tools>`, delivered: fp };
}

/** Recall's own input never matches on the tools list: its `<super-tools>` blocks are cut. */
export function stripSuperToolsBlocks(prompt: string): string {
  return prompt.includes('<super-tools') ? prompt.replace(/<super-tools fp=[0-9a-f]{12}>[\s\S]*?<\/super-tools>\n?/g, '') : prompt;
}
