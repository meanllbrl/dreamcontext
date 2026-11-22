/**
 * The Super's `<super-models eco=plus|off>` turn block (plan eco-plus D5, K6). The briefing's
 * Model rows never change (no variant, no `SUPER_BRIEF_REV` move); under Eco Plus this block
 * carries the Eco Plus table and says it replaces them, and turning Eco Plus off sends
 * `eco=off`, which says the briefing's rows apply again. Delivered like `<super-tools>`: in the
 * spawn's prompt, else on the next turn the Super receives (owner, Telegram or injected), once,
 * whenever the session holds another state than the current one.
 */

export type EcoModelsState = 'plus' | 'off';

const PLUS_BODY = [
  'Eco Plus is on for this Mac (Settings → Chat → Tasarruf modu): this table REPLACES the Model rows of your briefing',
  'until a super-models block with eco=off says otherwise. Effort rows stay as the briefing says.',
  '- haiku `low` ONLY for research that changes nothing (read, search, summarise).',
  '- small clear fix, merge, build, install, chores: `sonnet` `medium`.',
  '- multi-file develop, a bug with a repro, analysis: `sonnet` `medium`.',
  '- plans: `sonnet` `high`.',
  '- Escalation stays Opus: a security, money, data migration, auth or contract job, plan or develop:',
  '  `--model opus --effort high`; a Sonnet develop child whose reviewer FAILs the same wave twice:',
  '  `dreamcontext super update <child> --model opus`; the owner names Opus: Opus.',
  '- Sub-agents follow on their own: an Opus dispatch runs on Sonnet; reviewer, review-security and',
  '  goal-plan-reviewer stay Opus.',
  '- On `--tool codex|antigravity`: rows that say opus take that tool\'s mid model, escalation rows its large one.',
].join('\n');

const OFF_BODY = 'Eco Plus is off for this Mac: the Model rows of your briefing apply again, as written there.';

const TAG_RE = /<super-models eco=(plus|off)>/g;

/** The block for one state. */
export function renderModelsBlock(state: EcoModelsState): string {
  return `<super-models eco=${state}>\n${state === 'plus' ? PLUS_BODY : OFF_BODY}\n</super-models>`;
}

/** The last `<super-models>` state in a text, or null. */
export function modelsStateIn(text: string): EcoModelsState | null {
  let last: EcoModelsState | null = null;
  for (const m of text.matchAll(TAG_RE)) last = m[1] as EcoModelsState;
  return last;
}

/**
 * The state a resumed main Super session holds, from its transcript: the block in its birth
 * prompt (`prompt_snapshot`; a snapshot without one was born `off`), then the last block a turn
 * carried since its last compaction. No snapshot line at all: `inPrompt` null (unknown).
 */
export function superModelsState(jsonl: string): { inPrompt: EcoModelsState | null; delivered: EcoModelsState | null } {
  let inPrompt: EcoModelsState | null = null;
  let viaMessage: EcoModelsState | null = null;
  for (const line of jsonl.split('\n')) {
    const snapshot = line.includes('prompt_snapshot');
    if (!snapshot && !line.includes('super-models') && !line.includes('compact_boundary')) continue;
    let o: { type?: string; subtype?: string; isCompactSummary?: boolean; attachment?: { type?: string }; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isCompactSummary) continue;
    if (o.type === 'system' && o.subtype === 'compact_boundary') { viaMessage = null; continue; }
    if (o.attachment?.type === 'prompt_snapshot') {
      inPrompt = modelsStateIn(line) ?? 'off';
      continue;
    }
    if (o.type !== 'user') continue;
    const content = Array.isArray(o.message?.content) ? o.message.content as Array<{ type?: unknown; text?: unknown }> : [];
    for (const b of content) {
      const s = b?.type === 'text' && typeof b.text === 'string' ? modelsStateIn(b.text) : null;
      if (s) viaMessage = s;
    }
  }
  return { inPrompt, delivered: viaMessage ?? inPrompt };
}

/**
 * The block a turn carries: the current state's when the session holds another one (`delivered`,
 * null = unknown, so it rides once), else none. A `/` command carries none.
 */
export function superModelsTurn(i: { text: string; now: EcoModelsState; delivered: EcoModelsState | null }): string | null {
  if (i.text.startsWith('/')) return null;
  return i.delivered === i.now ? null : renderModelsBlock(i.now);
}

/** Recall's own input never matches on the model table: its `<super-models>` blocks are cut. */
export function stripSuperModelsBlocks(prompt: string): string {
  return prompt.includes('<super-models') ? prompt.replace(/<super-models eco=(?:plus|off)>[\s\S]*?<\/super-models>\n?/g, '') : prompt;
}
