import { readFileSync } from 'node:fs';

/**
 * `dreamcontext super ask`'s body, built from its argv (pure but for reading `@file` / `-`).
 *
 * Three ways in, one shape out: the question in AskUserQuestion's own input shape, which the
 * chat draws with the same card a normal agent's question gets.
 *   --json '<AskUserQuestion input>' | --json @file | --json -  (stdin)
 *   "<question>" with --title --description --header --multi --option "label::description"…
 *   "<question>" --options "a|b"   (the old form: sent exactly as before)
 */
export interface AskCliOpts {
  options?: string;
  json?: string;
  title?: string;
  description?: string;
  header?: string;
  multi?: boolean;
  option?: string[];
}

/** Commander's collector for a repeatable `--option`. */
export function collectOption(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

function readJsonArg(arg: string, readStdin: () => string): unknown {
  const src = arg === '-' ? readStdin() : arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf-8') : arg;
  try {
    return JSON.parse(src);
  } catch (err) {
    throw new Error(`--json is not valid JSON: ${(err as Error).message}`);
  }
}

export function buildAskBody(
  text: string | undefined,
  o: AskCliOpts,
  readStdin: () => string = () => readFileSync(0, 'utf-8'),
): Record<string, unknown> {
  if (o.json !== undefined) {
    if (text || o.options || o.title || o.description || o.header || o.multi || o.option?.length) {
      throw new Error('--json carries the whole question: give no text or other flags with it');
    }
    return { ask: readJsonArg(o.json, readStdin) };
  }
  if (!text) throw new Error('write the question, or give it whole with --json');
  const rich = o.title !== undefined || o.description !== undefined || o.header !== undefined || o.multi || (o.option?.length ?? 0) > 0;
  if (!rich) return { text, ...(o.options ? { options: o.options.split('|').map((x) => x.trim()) } : {}) };
  if (o.options && o.option?.length) throw new Error('use --option (repeatable) or --options "a|b", not both');
  const labels = o.option?.length
    ? o.option.map((raw) => {
      const at = raw.indexOf('::');
      return at < 0 ? { label: raw.trim() } : { label: raw.slice(0, at).trim(), description: raw.slice(at + 2).trim() };
    })
    : (o.options ? o.options.split('|').map((x) => ({ label: x.trim() })) : []);
  return {
    ask: {
      ...(o.title ? { title: o.title } : {}),
      questions: [{
        question: text,
        ...(o.header ? { header: o.header } : {}),
        ...(o.description ? { description: o.description } : {}),
        ...(o.multi ? { multiSelect: true } : {}),
        options: labels,
      }],
    },
  };
}
