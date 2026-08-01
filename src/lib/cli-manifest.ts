import type { Command } from 'commander';

/**
 * The CLI's own command tree, flattened into data.
 *
 * This exists so that ONE surface — the dashboard's chat transcript — can recognise a
 * `dreamcontext …` shell call and render it as the action it is (a task created, a memory
 * recalled) instead of an opaque line of bash. The alternative was a hand-written list of
 * commands inside the dashboard, which this repo has already been burned by twice: a mirrored
 * constant drifts silently the moment someone adds an endpoint and doesn't think to update a
 * file in another package (see the sleep-threshold drift the dashboard test now guards).
 *
 * So the list is DERIVED from `createProgram()` and checked into
 * `dashboard/src/generated/cli-manifest.json` by `tests/unit/cli-manifest.test.ts`, which
 * fails the suite whenever the committed file and the real tree disagree. Adding a command is
 * enough to make the UI understand it; nobody has to remember this file exists.
 */

/** One command node — a group (`tasks`) or a leaf (`tasks create`), both kept. */
export interface CliEndpoint {
  /** Space-joined path from the root, WITHOUT the `dreamcontext` prefix: `tasks create`. */
  path: string;
  /** The command's own `.description()` — the endpoint's one-line meaning, straight from the
   *  source of truth, so a row can explain itself without anyone writing UI copy. */
  desc: string;
  /** Positional arguments in commander's display form: `<name>`, `[slug]`, `[words...]`. */
  args: string[];
  /** True when this node has subcommands, i.e. the NEXT token is an action and not an
   *  argument. This is the single fact a parser cannot guess from the command line alone. */
  group?: true;
  /** `.alias()` names, so `dreamcontext mk …` resolves to `marketing`. */
  aliases?: string[];
  /** Every option token that consumes the token after it (`-p`, `--priority`). Without this a
   *  parser reads the VALUE of a flag as a positional: `tasks create -p high "Fix it"` would
   *  be titled "high". Flags that take no value are omitted — they need no lookahead. */
  valueFlags?: string[];
}

export interface CliManifest {
  /** Bumped only when the SHAPE above changes, so a consumer can refuse a file it predates. */
  version: number;
  /** Sorted by `path`, so the checked-in file diffs by command rather than by registration
   *  order (which changes whenever someone reorders a `register…Command` call). */
  endpoints: CliEndpoint[];
}

export const CLI_MANIFEST_VERSION = 1;

/** Commander's own display form for a declared argument. `.registeredArguments` exposes the
 *  parsed pieces but not the rendered token, and the rendered token is what reads in a diff. */
function argToken(arg: { name(): string; required: boolean; variadic: boolean }): string {
  const inner = `${arg.name()}${arg.variadic ? '...' : ''}`;
  return arg.required ? `<${inner}>` : `[${inner}]`;
}

function valueFlagsOf(cmd: Command): string[] {
  const flags: string[] = [];
  for (const opt of cmd.options) {
    // `required`/`optional` here mean "the option takes a value", mandatorily or optionally —
    // NOT whether the option itself must be passed. Both consume the next token.
    if (!opt.required && !opt.optional) continue;
    if (opt.short) flags.push(opt.short);
    if (opt.long) flags.push(opt.long);
  }
  return flags;
}

function walk(cmd: Command, prefix: string[], out: CliEndpoint[]): void {
  const path = [...prefix, cmd.name()].join(' ');
  const subs = cmd.commands as Command[];
  const entry: CliEndpoint = {
    path,
    desc: cmd.description() || '',
    args: (cmd.registeredArguments ?? []).map(argToken),
  };
  if (subs.length > 0) entry.group = true;
  const aliases = cmd.aliases();
  if (aliases.length) entry.aliases = aliases;
  const valueFlags = valueFlagsOf(cmd);
  if (valueFlags.length) entry.valueFlags = valueFlags;
  out.push(entry);
  for (const sub of subs) walk(sub, [...prefix, cmd.name()], out);
}

/**
 * Flatten a built program into the manifest. The ROOT itself is not an endpoint (nobody runs
 * bare `dreamcontext` from an agent), so its children are walked with an empty prefix.
 */
export function buildCliManifest(program: Command): CliManifest {
  const out: CliEndpoint[] = [];
  for (const cmd of program.commands as Command[]) walk(cmd, [], out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: CLI_MANIFEST_VERSION, endpoints: out };
}

/** The exact bytes the checked-in file must hold — one place, so the test that verifies it and
 *  any tool that writes it can never disagree about formatting. */
export function serializeCliManifest(manifest: CliManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
