import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { resolveContextRoot } from '../../lib/context-path.js';
import {
  PeopleStoreError,
  addPerson,
  listPeople,
  normalizeEmails,
  personFilePath,
  removePerson,
  type Person,
} from '../../lib/people-store.js';
import { resolveActivePerson, setActivePersonPin } from '../../lib/people-resolve.js';
import { header, success, error, info, warn, formatTable } from '../../lib/format.js';

/**
 * `dreamcontext people` — the single surface for WHO works in this vault.
 *
 * The roster (`people/people.json`) is structural and synced; the active person
 * is resolved per machine and never written into the synced brain except by an
 * explicit `whoami --set` (which lands in the gitignored `.brain-local.json`).
 *
 * Every verb here reads the roster through `readRoster`, so a corrupt
 * `people.json` becomes a named CLI failure instead of a stack trace — `doctor`
 * is the tool that diagnoses it, and telling the user to run it is more useful
 * than a JSON parse error at an unknown byte offset.
 */

/** Roster-relative display path, e.g. `_dream_context/people/ada.md`. */
function vaultRelative(contextRoot: string, absPath: string): string {
  return relative(dirname(contextRoot), absPath);
}

function requireContextRoot(): string | undefined {
  const contextRoot = resolveContextRoot();
  if (!contextRoot) {
    error('Not inside a dreamcontext project.', 'Run `dreamcontext init` first.');
    process.exitCode = 1;
    return undefined;
  }
  return contextRoot;
}

/**
 * `listPeople`, with `PeopleStoreError` turned into a clean exit-1. Returns
 * `undefined` when the roster could not be read — callers must bail on it.
 */
function readRoster(contextRoot: string): Array<Person & { slug: string }> | undefined {
  try {
    return listPeople(contextRoot);
  } catch (err) {
    if (err instanceof PeopleStoreError) {
      error(err.message, 'Fix _dream_context/people/people.json, or run `dreamcontext doctor` for the full diagnosis.');
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
}

/** Report a store write failure the same way everywhere. Returns true when it handled the error. */
function reportStoreError(err: unknown, hint?: string): boolean {
  if (err instanceof PeopleStoreError) {
    error(err.message, hint);
    process.exitCode = 1;
    return true;
  }
  return false;
}

export function registerPeopleCommand(program: Command): void {
  const people = program
    .command('people')
    .description('Who works in this vault — roster, per-person constitutions, and the active person');

  people
    .command('list', { isDefault: true })
    .description("List this vault's people roster")
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const contextRoot = requireContextRoot();
      if (!contextRoot) return;
      const roster = readRoster(contextRoot);
      if (!roster) return;
      const active = resolveActivePerson(contextRoot);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              activeSlug: active.slug,
              source: active.source,
              people: roster.map((p) => ({
                slug: p.slug,
                name: p.name,
                emails: p.emails,
                ...(p.role ? { role: p.role } : {}),
                active: p.slug === active.slug,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(header('People'));
      if (roster.length === 0) {
        info('No people yet.');
        console.log(chalk.dim('  Add one: dreamcontext people add "Ada Lovelace" --email ada@example.com'));
        return;
      }
      console.log(
        formatTable(
          ['SLUG', 'NAME', 'EMAILS', 'ROLE', ''],
          roster.map((p) => [
            p.slug,
            p.name,
            p.emails.join(', ') || '—',
            p.role ?? '—',
            p.slug === active.slug ? '← you' : '',
          ]),
        ),
      );
      console.log(
        chalk.dim(`\n  Active: ${active.slug ?? '(unresolved)'} (source: ${active.source}) — ${active.reason}`),
      );
    });

  people
    .command('add <name>')
    .description("Add a person to the roster and scaffold their constitution file")
    .option('--email <email...>', "Email address (repeatable) — how this person's machine is recognised from git config")
    .option('--role <role>', 'Structural role label (e.g. founder, backend) — a label, never prose')
    .action((name: string, opts: { email?: string[]; role?: string }) => {
      const contextRoot = requireContextRoot();
      if (!contextRoot) return;
      const before = readRoster(contextRoot);
      if (!before) return;

      const emails = normalizeEmails(opts.email);

      let result: { slug: string; created: boolean };
      try {
        result = addPerson(contextRoot, { name, emails, role: opts.role });
      } catch (err) {
        if (reportStoreError(err, 'Use a name that yields a slug of lowercase letters, digits and dashes.')) return;
        throw err;
      }
      const { slug, created } = result;

      // Duplicate-email warning: the roster still accepts it (one human with two
      // accounts is legitimate), but two PEOPLE sharing an address makes rung 3
      // of the resolution ladder ambiguous, so say so out loud.
      for (const email of emails) {
        for (const other of before) {
          if (other.slug !== slug && other.emails.includes(email)) {
            warn(`${email} is already on ${other.name} (person:${other.slug}) — git-email resolution between them is ambiguous.`);
          }
        }
      }

      const filePath = personFilePath(contextRoot, slug);
      success(
        created
          ? `Added ${name} (person:${slug}).`
          : `${name} (person:${slug}) was already on the roster — merged the new details in.`,
      );
      console.log(chalk.dim(`  Constitution: ${vaultRelative(contextRoot, filePath)}`));
      if (emails.length === 0) {
        info(chalk.dim(`No email given — this person cannot be matched from git config. Add one: dreamcontext people add "${name}" --email <address>`));
      }
    });

  people
    .command('show [slug]')
    .description("Print a person's constitution (defaults to the active person on this machine)")
    .action((slugArg: string | undefined) => {
      const contextRoot = requireContextRoot();
      if (!contextRoot) return;
      const roster = readRoster(contextRoot);
      if (!roster) return;

      let slug = (slugArg ?? '').trim();
      if (!slug) {
        const active = resolveActivePerson(contextRoot);
        if (!active.slug) {
          error('No active person on this machine.', active.reason);
          console.log(
            chalk.dim('  Fix: dreamcontext people whoami --set <slug>, or dreamcontext people add "<name>" --email <your git user.email>'),
          );
          process.exitCode = 1;
          return;
        }
        slug = active.slug;
      }

      // Invariant P: only a slug that is a real roster key ever reaches a path join.
      const person = roster.find((p) => p.slug === slug);
      if (!person) {
        error(`No person "${slug}" on this vault's roster.`, 'Run `dreamcontext people list` to see who is on it.');
        process.exitCode = 1;
        return;
      }

      const filePath = personFilePath(contextRoot, person.slug);
      if (!existsSync(filePath)) {
        error(
          `${vaultRelative(contextRoot, filePath)} is missing.`,
          `Re-scaffold it: dreamcontext people add "${person.name}"`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(readFileSync(filePath, 'utf-8').trimEnd());
    });

  people
    .command('whoami')
    .description('Show — or pin — who dreamcontext thinks is at this keyboard')
    .option('--set <slug>', 'Pin this machine to a person (machine-local, never synced)')
    .option('--clear', "Remove this machine's person pin")
    .action((opts: { set?: string; clear?: boolean }) => {
      const contextRoot = requireContextRoot();
      if (!contextRoot) return;
      const projectRoot = dirname(contextRoot);

      if (opts.set !== undefined && opts.clear) {
        error('--set and --clear cannot be used together.', 'Pick one: --set <slug> pins this machine, --clear unpins it.');
        process.exitCode = 1;
        return;
      }

      if (opts.set !== undefined || opts.clear) {
        const target = opts.clear ? null : (opts.set ?? '').trim();
        try {
          setActivePersonPin(projectRoot, target);
        } catch (err) {
          if (reportStoreError(err, 'Run `dreamcontext people list` to see the valid slugs.')) return;
          throw err;
        }
        success(target === null ? 'Person pin cleared on this machine.' : `Pinned this machine to person:${target}.`);
        console.log(
          chalk.dim('  Stored in _dream_context/state/.brain-local.json (gitignored — machine identity never enters the synced brain).'),
        );
      }

      const active = resolveActivePerson(contextRoot);
      console.log(header('People — whoami'));
      console.log(`  Person:  ${active.slug ? chalk.white(active.slug) : chalk.yellow('(unresolved)')}`);
      console.log(`  Name:    ${active.name ? chalk.white(active.name) : chalk.dim('—')}`);
      console.log(`  Source:  ${chalk.white(active.source)}`);
      console.log(`  Why:     ${chalk.dim(active.reason)}`);
    });

  people
    .command('rm <slug>')
    .description('Remove a person from the roster (their constitution file is kept)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (slugArg: string, opts: { yes?: boolean }) => {
      const contextRoot = requireContextRoot();
      if (!contextRoot) return;
      const roster = readRoster(contextRoot);
      if (!roster) return;

      const slug = (slugArg ?? '').trim();
      const target = roster.find((p) => p.slug === slug);
      if (!target) {
        error(`No person "${slug}" on this vault's roster.`, 'Run `dreamcontext people list` to see who is on it.');
        process.exitCode = 1;
        return;
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          error('Refusing to remove a person without confirmation.', 'Re-run with --yes.');
          process.exitCode = 1;
          return;
        }
        const ok = await confirm({
          message: `Remove ${target.name} (person:${target.slug}) from the roster?`,
          default: false,
        });
        if (!ok) {
          info('Cancelled — the roster is unchanged.');
          return;
        }
      }

      try {
        removePerson(contextRoot, target.slug);
      } catch (err) {
        if (reportStoreError(err)) return;
        throw err;
      }

      success(`Removed ${target.name} (person:${target.slug}) from the roster.`);
      console.log(
        chalk.dim(`  Kept ${vaultRelative(contextRoot, personFilePath(contextRoot, target.slug))} — a person's prose outlives their roster membership. Delete it by hand if you mean to.`),
      );
      console.log(
        chalk.dim('  Note: the roster merges as a UNION across machines, so a teammate who still has this person will resurrect them on the next brain sync. Remove them there too.'),
      );
    });
}
