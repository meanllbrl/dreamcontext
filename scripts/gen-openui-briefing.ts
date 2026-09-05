/**
 * Generates `src/server/chat-surface-openui.generated.ts` from the trimmed component library.
 *
 * ONE code path, two callers: `gen-openui-briefing.run.ts` (behind
 * `npm run gen:openui-briefing`) writes what this returns; `tests/unit/openui-briefing.test.ts`
 * compares the committed file against it. A generator and a checker that could disagree
 * would defeat the point of having either.
 *
 * PURE ON IMPORT — no side effect here, which is why the write lives in the tiny runner next
 * to it rather than behind an `argv` guard: under `vite-node` the script path is not in
 * `process.argv` at all, so such a guard silently never fires and the generator quietly does
 * nothing (observed, 2026-09-05).
 *
 * It is a script rather than part of the test because the generated file is IMPORTED by
 * `chat-surface-openui.ts` — a test that both produced and consumed it could not run the
 * first time, before the file existed.
 */
import {
  openUiChatLibrary, OPENUI_PREAMBLE, OPENUI_ADDITIONAL_RULES, OPENUI_COMPONENT_NAMES,
  OPENUI_SHIPPED_COMPONENT_NAMES,
} from '../dashboard/src/components/sleepy/chat/openuiLibrary.js';

/**
 * Narrow every child-type union in the generated signatures to the components we actually
 * kept.
 *
 * FOUND THE HARD WAY (2026-09-05): filtering a library's component LIST does not filter the
 * component SCHEMAS. `Card`'s children are typed as a union naming all 29 shipped
 * components, so the generated prompt told the agent it could put a `Form`, a `Carousel` or
 * a `ScatterChart` inside a Card — none of which the trimmed library can render. That is the
 * surface's oldest failure mode restated in a new notation: a briefing that names a
 * capability the view does not have, so the agent writes a promise the UI then breaks.
 *
 * The transform is deliberately narrow. It only touches PARENTHESISED unions of bare
 * identifiers — `(A | B | C)` — which is how child types are printed; unions of quoted string
 * literals (`"small" | "large"`) contain quotes and are left alone. Anything still naming a
 * dropped component after this fails `openui-briefing.test.ts` rather than shipping.
 *
 * The cleaner fix is to redefine the container components with narrowed Zod schemas over the
 * shipped renderers. That is worth doing if this vocabulary grows; for a 19-component subset
 * it would mean re-deriving schemas we do not own in order to say something a text pass says
 * exactly as reliably, and checks.
 */
/**
 * Drop the generated "Action — Button Behavior" section entirely.
 *
 * `Library.prompt()` emits it unconditionally: neither `toolCalls:false` nor `bindings:false`
 * removes it (measured — all four combinations produce the identical 6,640 characters). It
 * teaches `Button(...)`, `Action([@ToAssistant(...)])` and `@OpenUrl("https://...")`, and all
 * three are wrong here for reasons that are not about budget:
 *
 *   • `Button` is not in this vocabulary. The section documents behaviour for a component the
 *     agent cannot draw.
 *   • Even once buttons arrive (Wave 5), an action must not be invented by the renderer. This
 *     surface already HAS a way for an answer to offer a real action — a `dream-actions`
 *     block, whose targets are validated and whose `url` kind is gated to https on both the
 *     client and the Rust side. `@OpenUrl` is a second, ungated path to the same affordance,
 *     which is precisely the kind of quiet duplicate a security boundary dies of.
 *
 * Removed here rather than left for the model to ignore, because a system prompt that
 * describes an unusable capability spends the model's attention teaching it to fail.
 */
function stripActionSection(prompt: string): string {
  let out = prompt;
  const start = out.indexOf('## Action');
  if (start >= 0) {
    const next = out.indexOf('\n## ', start + 1);
    out = next < 0 ? out.slice(0, start).trimEnd() + '\n' : out.slice(0, start) + out.slice(next + 1);
  }
  // The section is not the only mention: the signature preamble carries a one-line pointer to
  // it ("Props typed `ActionExpression` … See the Action section … (@ToAssistant, @OpenUrl)").
  // Left behind, it would reference a section that no longer exists — a dangling instruction
  // is worse than the section itself, because the model cannot tell it was removed on purpose.
  out = out.split('\n').filter((line) => !line.startsWith('Props typed `ActionExpression`')).join('\n');
  return out;
}

function narrowUnionsToKeptComponents(prompt: string): string {
  const kept = new Set<string>(OPENUI_COMPONENT_NAMES);
  const shipped = new Set<string>(OPENUI_SHIPPED_COMPONENT_NAMES);
  return prompt.replace(/\(([A-Za-z][A-Za-z0-9]*(?: \| [A-Za-z][A-Za-z0-9]*)+)\)/g, (whole, body: string) => {
    const parts = body.split(' | ');
    // Only a union of COMPONENT names is ours to narrow. A union of anything else (a prop
    // enum printed without quotes, a type name we do not know) is left exactly as written.
    if (!parts.every((n) => shipped.has(n))) return whole;
    const filtered = parts.filter((n) => kept.has(n));
    return filtered.length ? `(${filtered.join(' | ')})` : whole;
  });
}

export const OPENUI_GENERATED_PATH = 'src/server/chat-surface-openui.generated.ts';

export function renderGeneratedFile(): string {
  const prompt = (openUiChatLibrary as unknown as { prompt: (o: unknown) => string }).prompt({
    preamble: OPENUI_PREAMBLE,
    additionalRules: OPENUI_ADDITIONAL_RULES,
    // Tools are categorically out while this renders in-process - see `OpenUiRenderer`'s
    // `toolProvider={null}`. Generating instructions for a capability the renderer refuses
    // is exactly the broken promise the surface's lockstep rule forbids.
    toolCalls: false,
  });
  const narrowed = stripActionSection(narrowUnionsToKeptComponents(prompt));
  return [
    '/**',
    ' * GENERATED - do not edit by hand.',
    ' *',
    ' * Produced by `npm run gen:openui-briefing` from the component library in',
    ' * `dashboard/src/components/sleepy/chat/openuiLibrary.ts`. Committed so the server can',
    " * build the OpenUI system prompt without importing React or the dashboard's dependency",
    ' * tree; `tests/unit/openui-briefing.test.ts` fails if this file and that library disagree.',
    ' *',
    ' * To change what the agent is told: change the LIBRARY, then regenerate.',
    ' */',
    'export const OPENUI_GENERATED_BRIEFING = ' + JSON.stringify(narrowed) + ';',
    '',
  ].join('\n');
}

// vite-node reports the script path in argv; guard on the filename so importing this module
// from a test never writes anything.
