import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../src/cli/program.js';
import { createProgramFor, lazyCommandNames } from '../../src/cli/lazy-program.js';

/**
 * The lazy start (`src/cli/lazy-program.ts`) must build, for every top-level command, exactly the
 * command the full tree builds: same name, aliases, options, help text and subcommands, all the
 * way down. A command added to `program.ts` and not to the lazy table fails here, as does a
 * table entry that wires the wrong register function.
 */

/** Every command's help text and identity, depth first. */
function shape(cmd: Command, path: string[] = []): string[] {
  const here = [...path, cmd.name()];
  const own = [
    `## ${here.join(' ')} [${cmd.aliases().join(',')}]`,
    cmd.helpInformation(),
    cmd.options.map((o) => `${o.flags}=${JSON.stringify(o.defaultValue ?? null)}`).join('\n'),
  ];
  return [...own, ...cmd.commands.flatMap((c) => shape(c, here))];
}

describe('lazy program', () => {
  const full = createProgram();
  const topNames = full.commands.flatMap((c) => [c.name(), ...c.aliases()]);

  it('answers for every top-level name and alias of the full tree, and nothing else', () => {
    expect([...lazyCommandNames()].sort()).toEqual([...topNames].sort());
  });

  it('declines a start that names no command, so the full tree handles it', async () => {
    for (const arg of [undefined, 'help', '--help', '-h', 'tasksx', '__proto__', 'constructor', 'toString']) {
      expect(await createProgramFor(arg)).toBeNull();
    }
  });

  it('builds each top-level command exactly as the full tree does', async () => {
    for (const name of topNames) {
      const lazy = await createProgramFor(name);
      expect(lazy, name).not.toBeNull();
      const want = full.commands.find((c) => c.name() === name || c.aliases().includes(name))!;
      const got = lazy!.commands.find((c) => c.name() === want.name());
      expect(got, name).toBeDefined();
      expect(shape(got!).join('\n'), name).toBe(shape(want).join('\n'));
      // The root itself is configured the same (help settings are copied into subcommands).
      expect(lazy!.name()).toBe(full.name());
      expect(lazy!.description()).toBe(full.description());
    }
  });
});
