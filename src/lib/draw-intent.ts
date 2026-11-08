/**
 * Does this prompt ask for a drawing? The UserPromptSubmit hook prints one line naming the `draw`
 * skill when it does, on every tool, so loading the drawing rules never rests on the skill's
 * description alone (owner, 2026-11-07: "tam olarak doğru zamanda doğru şekilde").
 *
 * Pure: the caller passes the project's whiteboard slugs in. Words are folded (Turkish letters to
 * ASCII, lower case) and matched as whole tokens or fixed prefixes, never compiled into a regex
 * from input, so a board slug can never change what matches.
 *
 * Precision matters more than recall here: one wrong line on every "drawer bug" prompt would
 * teach the agent to skip it. `drawer`, `withdraw`, `çizelge` (a schedule), a person named Sema,
 * "the chart colour bug" and a Lab board without a draw verb stay silent.
 */
import { foldAscii } from './fold-ascii.js';

export type DrawTarget = 'whiteboard' | 'file' | 'any';

/** Split into folded word tokens (`whiteboard'a` → `whiteboard`, `a`). */
function tokens(text: string): string[] {
  return foldAscii(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/** A verb that makes a drawing (`grafik çiz`, `draw a chart`). */
const isDrawVerb = (t: string): boolean =>
  (t.startsWith('ciz') && !t.startsWith('cizelge'))
  || t === 'draw' || t === 'draws' || t === 'drawing' || t === 'drawn' || t === 'sketch' || t === 'sketches';
/** On a whiteboard, explaining or showing something is drawing it too (`tahtada anlat`). */
const isBoardVerb = (t: string): boolean => isDrawVerb(t) || t.startsWith('anlat') || t.startsWith('goster');

/** A token that asks for a drawing on its own. */
const isDrawWord = (t: string): boolean =>
  t === 'excalidraw'
  || t.startsWith('whiteboard')
  || t.startsWith('diagram') || t.startsWith('diyagram')
  || t.startsWith('flowchart')
  || t.startsWith('wireframe')
  || t.startsWith('mockup')
  || t === 'draw' || t === 'draws' || t === 'drawing' || t === 'sketch' || t === 'sketches'
  || (t.startsWith('ciz') && !t.startsWith('cizelge'));

/** Does `seq` occur in `toks` as consecutive tokens (the last one by prefix)? */
function hasSequence(toks: readonly string[], seq: readonly string[]): boolean {
  if (seq.length === 0) return false;
  for (let i = 0; i + seq.length <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      const t = toks[i + j]!;
      const want = seq[j]!;
      if (j === seq.length - 1 ? !t.startsWith(want) : t !== want) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * The drawing a prompt asks for, or null. `target`: `whiteboard` when a whiteboard word or one of
 * the project's board slugs is named; `file` when an Excalidraw file, a file, a knowledge diagram
 * or keeping it is named; otherwise `any` (in the Chat view that one may be an inline sketch).
 */
export function detectDrawIntent(prompt: string, boardSlugs: readonly string[] = []): { target: DrawTarget } | null {
  if (!prompt || !prompt.trim()) return null;
  const toks = tokens(prompt);
  const hasVerb = toks.some(isDrawVerb);
  const hasBoardVerb = toks.some(isBoardVerb);
  const excalidrawFile = /\.excalidraw(\.md)?\b/i.test(prompt);
  const fires = excalidrawFile
    || toks.some(isDrawWord)
    || hasSequence(toks, ['akis', 'sema'])
    || (hasBoardVerb && toks.some((t) => t.startsWith('tahta')))
    || (hasVerb && toks.some((t) => t === 'chart' || t === 'charts' || t.startsWith('grafik')));
  if (!fires) return null;

  const slugHit = boardSlugs.some((slug) => hasSequence(toks, tokens(slug.replace(/-/g, ' '))) && tokens(slug).length > 0);
  const whiteboard = toks.some((t) => t.startsWith('whiteboard') || t.startsWith('tahta'))
    || hasSequence(toks, ['control', 'panel'])
    || hasSequence(toks, ['kontrol', 'panel'])
    || slugHit;
  if (whiteboard) return { target: 'whiteboard' };

  const file = excalidrawFile
    || toks.includes('excalidraw')
    || toks.some((t) => t === 'file' || t === 'files' || t.startsWith('dosya'))
    || toks.some((t) => t === 'save' || t === 'keep' || t.startsWith('kaydet') || t.startsWith('sakla'))
    || (toks.includes('knowledge') && toks.some((t) => t.startsWith('diagram')));
  return { target: file ? 'file' : 'any' };
}

/**
 * The one line the hook prints for a drawing prompt. `chatView`: the dreamcontext Chat view (an
 * inline `dc-graph` answers a passing sketch there, owner decision 2026-11-08). `tool`: a non-Claude
 * turn, worded without Claude's tool names.
 */
export function drawDirective(target: DrawTarget, o: { chatView: boolean; tool: 'codex' | 'antigravity' | null }): string {
  const load = o.tool ? 'open the `draw` skill (its SKILL.md)' : 'load the `draw` skill (Skill tool)';
  if (o.chatView && target === 'any') {
    return `Drawing request: if this drawing is only part of your answer, draw it as a dream-html dc-graph. If it must be kept (a whiteboard, an Excalidraw file, a knowledge diagram), ${load} first.`;
  }
  const kit = target === 'whiteboard' ? ' Then run `dreamcontext whiteboard kit`.' : '';
  return `Drawing request: ${load} before you draw.${kit}`;
}

/**
 * Gate 1e (Claude only, owner decision 2026-11-08): a hand-written Excalidraw scene. The builder
 * writes these files itself, so a Write/Edit whose new text carries scene JSON into an
 * `.excalidraw.md` / `.excalidraw` file is an agent skipping the kit. Frontmatter and
 * `## Text Elements` edits carry no scene and pass. Anything unreadable passes: the rule is
 * guidance, not safety.
 */
export function excalidrawHandWriteRefusal(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return null;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
  if (!/\.excalidraw(\.md)?$/i.test(filePath)) return null;
  const texts: string[] = [];
  if (typeof toolInput.content === 'string') texts.push(toolInput.content);
  if (typeof toolInput.new_string === 'string') texts.push(toolInput.new_string);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      const s = e && typeof e === 'object' ? (e as { new_string?: unknown }).new_string : undefined;
      if (typeof s === 'string') texts.push(s);
    }
  }
  if (!texts.some(isSceneJson)) return null;
  return 'This file is generated. Load the `draw` skill and build it from a spec (its `scripts/build_excalidraw.js`), or `dreamcontext whiteboard draw` for a whiteboard.';
}

const SCENE_ELEMENT = /"type"\s*:\s*"(rectangle|ellipse|diamond|arrow|line|text|freedraw|image|frame|embeddable)"/;

/** Excalidraw scene JSON: the scene header, or an elements list holding Excalidraw elements. */
function isSceneJson(text: string): boolean {
  if (/"type"\s*:\s*"excalidraw"/.test(text)) return true;
  return /"elements"\s*:\s*\[/.test(text) && SCENE_ELEMENT.test(text);
}
