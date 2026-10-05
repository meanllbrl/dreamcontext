/**
 * The production {@link HandsfreeEnv} for this laptop: GitHub Codespaces from the stored
 * handsfree token (re-read on every call, so `setup` can sign in first), the HTTP transfer
 * client, the devcontainer files from the package's `cloud/` dir, this package's version and
 * the npm registry (D25: the cloud installs exactly that version from npm). Turn control and the roster IO come from the caller: the
 * dashboard server passes its live registries, the CLI the process scan.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpCloudClient } from './cloud-client.js';
import { CodespacesProvider } from './codespaces.js';
import { packageRoot } from './fingerprint.js';
import { createSpawnRunner, type ProcessRunner } from './git-snapshot.js';
import { readConfig, readCredentials } from './local-store.js';
import { dreamcontextVersion } from '../manifest.js';
import { HandsfreeError, TEMPLATE_FILE_NAMES, type HandsfreeEnv } from './orchestrator.js';
import type { CloudProvider, TemplateRepo } from './provider.js';
import type { RosterIO } from './session-merge.js';
import type { TurnControl } from './turns.js';

type FetchImpl = typeof globalThis.fetch;

function codespacesFor(home: string, fetchImpl?: FetchImpl): CodespacesProvider {
  const creds = readCredentials(home);
  const owner = creds.githubLogin ?? readConfig(home)?.owner;
  if (!creds.githubToken || !owner) throw new HandsfreeError('not_setup', 'hands-free mode is not signed in to GitHub: run `dreamcontext handsfree setup`');
  return new CodespacesProvider({ token: creds.githubToken, owner, fetchImpl });
}

/** Delegates every call to a provider built from the CURRENT credentials. */
function lazyCodespaces(home: string, fetchImpl?: FetchImpl): CloudProvider & TemplateRepo {
  const p = () => codespacesFor(home, fetchImpl);
  return {
    kind: 'codespaces',
    create: (o) => p().create(o),
    start: (n) => p().start(n),
    stop: (n) => p().stop(n),
    delete: (n) => p().delete(n),
    get: (n) => p().get(n),
    remainingQuotaCoreMinutes: () => p().remainingQuotaCoreMinutes(),
    machineTypes: () => p().machineTypes(),
    ensure: () => p().ensure(),
    writeFiles: (f, m) => p().writeFiles(f, m),
    blobShas: (paths) => p().blobShas(paths),
  };
}

/** The devcontainer files (verbatim copies of the package's `cloud/` files, lane D). */
export function readTemplateFiles(root: string = packageRoot()): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const n of TEMPLATE_FILE_NAMES) {
    try {
      out[`.devcontainer/${n}`] = readFileSync(join(root, 'cloud', n));
    } catch {
      throw new HandsfreeError('not_setup', `this dreamcontext build has no cloud/${n}; update dreamcontext and run setup again`);
    }
  }
  return out;
}

export function laptopEnv(o: { turns: TurnControl; roster: RosterIO; home?: string; run?: ProcessRunner; fetchImpl?: FetchImpl }): HandsfreeEnv {
  const home = o.home ?? homedir();
  const run = o.run ?? createSpawnRunner();
  const provider = lazyCodespaces(home, o.fetchImpl);
  return {
    home,
    run,
    provider,
    repo: provider,
    connect: (origin, secret) => new HttpCloudClient({ origin, secret, fetchImpl: o.fetchImpl }),
    turns: o.turns,
    roster: o.roster,
    templateFiles: () => readTemplateFiles(),
    localVersion: () => dreamcontextVersion(),
    registryFetch: o.fetchImpl ?? globalThis.fetch,
  };
}
