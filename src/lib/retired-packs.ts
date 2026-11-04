import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { installAgentForPlatform } from './install-packs.js';
import { agentBaselineSha, isCustomizedAgent } from './sleep-specialist-frontmatter.js';
import { dreamcontextVersion, recordFile, PRE_MANIFEST_VERSION, type Manifest } from './manifest.js';

/**
 * Skill packs dreamcontext once shipped and has retired.
 *
 * The catalog no longer lists them, so `update` stops refreshing them, and the generic
 * stale-file prune would then offer every installed file for deletion, edited or not (it
 * has no content check for pack files). This module runs first and decides per file, by
 * content: a file whose bytes are exactly one version the pack shipped is ours and goes;
 * anything else is the user's work and stays, untracked, with one note the first time.
 *
 * `shipped` maps each file (relative to the pack folder) to the sha256 of every version
 * of it that ever shipped. Installed pack files are byte copies of the package, so a
 * match proves the copy is unmodified.
 *
 * `keepAgents` are agents the retired pack used to install that still ship in another
 * pack, each with the canonical hash (`agentBaselineSha`) of every version it shipped. A
 * project that only had the retired pack keeps them, refreshed from the package, instead
 * of losing them to the stale prune. The hashes matter on a project with no manifest (a
 * fresh clone or worktree: `_dream_context/state/` is gitignored): there the bootstrap
 * records the agent as a legacy file, and only its content can prove it is ours.
 */
export interface RetiredPack {
  name: string;
  retired: string;
  /** One line for the user: where the pack's content went. */
  replacedBy: string;
  shipped: Readonly<Record<string, readonly string[]>>;
  keepAgents: Readonly<Record<string, readonly string[]>>;
}

export const RETIRED_PACKS: readonly RetiredPack[] = [
  {
    // Owner, 2026-11-04: "ajanlar yutsun onu". The rules live in the build and review
    // agents (src/lib/code-standard.ts), so they hold where the pack was never installed.
    // One version ever shipped (f8e88c15, 2026-03-24) up to its removal.
    name: 'engineering',
    retired: '2026-11-04',
    replacedBy: 'its rules now live inside the build and review agents',
    shipped: {
      'SKILL.md': ['e1b0282f6f2275b8d56ae82f866c31d85d8e2385b26ec2e9fcda50062c7827d8'],
      'backend-principles.md': ['3193216f9a704a4c3eeabdb2d3412f5f0c588b0d2e41ceb53309b9effb2e0b41'],
      'web-app-frontend.md': ['34d6601774d89c2e971ae393783516c11c6e69a847ce03ef4c1a4337c8c1d483'],
      'firebase-cloud-functions/SKILL.md': ['430b6ce0616a7219c7481bd299a4d84747255d61b084fd59fe2aaed97aacf154'],
      'firebase-cloud-functions/references/gen_comparison.md': ['47d52d6b9e8516e6d51ccc743cbd45403dbc72a552a9d742b21a1c12b53bad85'],
      'firebase-cloud-functions/references/idempotency.md': ['099c302d3ac481ab73f1fe8ec92018ed26561906b3545307bb9fd5f77b60ca69'],
      'firebase-cloud-functions/references/local_testing.md': ['94d1c8ebbfd46241bb9cfb671fc74a6c62e0e945657535fbb66ad8eda028092f'],
      'firebase-cloud-functions/references/scaling.md': ['9bfe32db0b9fcd6192135b05321e8caee9724aeaee480b4a6d390191cb8feea1'],
      'firebase-cloud-functions/references/secrets.md': ['7b772e3f8f6b27e1956591802fe6915cb374a8f075521e3c30af18d03d7eb3a8'],
      'firebase-cloud-functions/references/triggers_and_deployment.md': ['a27e16f8f8dfe84472d8059b82e7295845323a11ed0800c6990d3d7ef1fad2f6'],
      'firebase-firestore/SKILL.md': ['4d7c12a3383f26a6b3163ea2dc634a0770c0cdd1cc64a30aa6a670cda3974637'],
      'firebase-firestore/references/indexes.md': ['03d113a2607ea09666c32b476eb0c98c1864046d73c259fba01b652af8dc73e1'],
      'firebase-firestore/references/provisioning.md': ['1b5ccf0c6ad4a2c1cc682f8955a1b4da5d6eedc27663f7cc45ac38caefa3928c'],
      'firebase-firestore/references/query_mechanics.md': ['a0e58c596b3c681f31aa07cf596124953ad11d1b608c1fdcd872a4cba85e65a3'],
      'firebase-firestore/references/security_rules.md': ['0fa0204822a98e98595c66fbcb8bc8bfb6030bfd2c40a17992338d62395ba282'],
      'firebase-firestore/references/web_sdk_usage.md': ['c07f07b09b9e6744b6d3168f27dfaec07c4ed3371bf8817b160a909c1af0a9bf'],
    },
    // Every reviewer.md the package shipped up to 0.40.6, canonical form (model/effort excluded).
    keepAgents: {
      reviewer: [
        '4f4894bf7d897ae2e34bdadcac08c22ff8acfd6da3866307999e9ac2e064074d',
        '5522fa4b0bf96fc46eb7a98a1a8be07ac2ff36eb2418e8c0fcdc757620eab15d',
        '6fcbb459689c9301ebe2eacdf4587195cbcbee4b5d4770cf8b6a4ec141d47e1a',
        '7bbed1f539e0714591337215552681e272c9b48bc1477999ada1ce1ae8f3520e',
        '8227b510fa3219b7520135ef704c0621279132149f77ed8ddf1881464f7ab592',
        'd7730f23f049341b9a2c74ed1335f79de9a0e251029c4aaa30efa307b28fa8aa',
      ],
    },
  },
];

export interface RetiredPackResult {
  /** Project-relative paths deleted because they were exactly what we shipped. */
  removed: string[];
  /** Project-relative paths left in place because they differ from every shipped version. */
  kept: string[];
  /** Lines for the user. A kept file is mentioned once: afterwards it is no longer tracked. */
  notes: string[];
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Every regular file under `dir`, never following a symlink. Symlinks are reported apart. */
function walkFiles(dir: string, out: string[], links: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) links.push(abs);
    else if (st.isDirectory()) walkFiles(abs, out, links);
    else if (st.isFile()) out.push(abs);
  }
}

/** Remove now-empty folders under (and including) `dir`, deepest first. */
function removeEmptyDirs(dir: string): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (lstatSync(abs).isDirectory()) removeEmptyDirs(abs);
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

const toPosix = (p: string): string => p.split(sep).join('/');

/**
 * Clear every retired pack out of a project during `update`, BEFORE the generic stale
 * prune diffs the manifests. Mutates both manifests:
 *  - every entry under the retired pack's folder leaves the OLD manifest, so the generic
 *    prune never offers a file this function kept (an edited file is not ours to delete);
 *  - its pack record leaves both;
 *  - a kept agent is re-recorded in the NEW manifest.
 *
 * `packsDir` is the package's `skill-packs/` (null when the catalog could not be found:
 * agents are then left exactly as they are).
 */
export function pruneRetiredPacks(
  projectRoot: string,
  oldManifest: Manifest,
  newManifest: Manifest,
  packsDir: string | null,
  packs: readonly RetiredPack[] = RETIRED_PACKS,
): RetiredPackResult {
  const result: RetiredPackResult = { removed: [], kept: [], notes: [] };

  for (const pack of packs) {
    const folderRel = `.claude/skills/${pack.name}`;
    const prefix = `${folderRel}/`;
    const wasTracked = (rel: string): boolean => Boolean(oldManifest.files[rel]);
    const keptTracked: string[] = [];
    const keptHere: string[] = [];
    const stuck: string[] = [];

    const folder = join(projectRoot, folderRel);
    let isDir = false;
    let isLink = false;
    try {
      const st = lstatSync(folder);
      isLink = st.isSymbolicLink();
      isDir = st.isDirectory();
    } catch {
      // not installed
    }
    const hadPack = isDir || Boolean(oldManifest.packs[pack.name]);

    if (isLink) {
      if (oldManifest.packs[pack.name]) {
        result.notes.push(`Left ${folderRel} alone: it is a symlink, and the retired ${pack.name} pack is never followed through one.`);
      }
    } else if (isDir) {
      const files: string[] = [];
      const links: string[] = [];
      walkFiles(folder, files, links);
      for (const abs of files) {
        const inPack = toPosix(relative(folder, abs));
        const rel = `${prefix}${inPack}`;
        const ours = (pack.shipped[inPack] ?? []).includes(sha256(readFileSync(abs)));
        if (ours) {
          try {
            rmSync(abs, { force: true });
            result.removed.push(rel);
          } catch (e: unknown) {
            // One locked file (Windows EBUSY, a read-only file) must not abort the update:
            // keep it tracked so the next run tries again.
            result.kept.push(rel);
            stuck.push(rel);
            result.notes.push(`Could not remove ${rel}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          result.kept.push(rel);
          keptHere.push(rel);
          if (wasTracked(rel)) keptTracked.push(rel);
        }
      }
      for (const abs of links) {
        const rel = `${prefix}${toPosix(relative(folder, abs))}`;
        result.kept.push(rel);
        keptHere.push(rel);
        if (wasTracked(rel)) keptTracked.push(rel);
      }
      try {
        removeEmptyDirs(folder);
      } catch {
        // A folder that will not go is harmless: the files that mattered are decided above.
      }
    }

    // "Once": this is the run that retires the pack, i.e. it removed shipped files, still had
    // the user's files tracked, or still had the pack recorded. Afterwards none of those holds.
    const removedHere = result.removed.some((r) => r.startsWith(prefix));
    const retiringNow = removedHere || keptTracked.length > 0 || Boolean(oldManifest.packs[pack.name]);
    if (removedHere) {
      result.notes.push(`Removed the retired ${pack.name} skill pack: ${pack.replacedBy}.`);
    }
    if (keptHere.length > 0 && retiringNow) {
      result.notes.push(
        `Kept ${keptHere.length} file(s) in ${folderRel}/ that differ from what dreamcontext shipped: the ${pack.name} pack is retired (${pack.replacedBy}), `
        + 'and dreamcontext no longer updates or tracks them. Delete the folder when you no longer need it.',
      );
    }

    for (const rel of Object.keys(oldManifest.files)) if (rel.startsWith(prefix) && !stuck.includes(rel)) delete oldManifest.files[rel];
    for (const rel of Object.keys(newManifest.files)) if (rel.startsWith(prefix)) delete newManifest.files[rel];
    // A file that could not be removed stays tracked, so the next update tries it again.
    for (const rel of stuck) recordFile(newManifest, rel, oldManifest.files[rel]?.version ?? dreamcontextVersion(), 'pack-skill');
    delete oldManifest.packs[pack.name];
    delete newManifest.packs[pack.name];

    for (const [agent, shippedShas] of Object.entries(pack.keepAgents)) {
      keepAgent(projectRoot, pack.name, agent, shippedShas, hadPack, retiringNow, oldManifest, newManifest, packsDir, result);
    }
  }
  return result;
}

/**
 * An agent the retired pack installed, still shipped elsewhere, that no pack installed this
 * run: keep it (refreshed when it is exactly a version we shipped) instead of letting the
 * stale prune delete it, or, on a project with no manifest, leave a stale copy that still
 * names the retired skill.
 *
 * Ours when the manifest says so (`pack-agent`, judged against its install baseline), or,
 * when the retired pack was present and the agent has no real record (no manifest: the
 * bootstrap marks it a legacy file), when its content matches a shipped version.
 */
function keepAgent(
  projectRoot: string,
  packName: string,
  name: string,
  shippedShas: readonly string[],
  hadPack: boolean,
  retiringNow: boolean,
  oldManifest: Manifest,
  newManifest: Manifest,
  packsDir: string | null,
  result: RetiredPackResult,
): void {
  const rel = `.claude/agents/${name}.md`;
  if (newManifest.files[rel]) return; // another pack installed it this run
  const recorded = oldManifest.files[rel];
  const legacy = !recorded || recorded.version === PRE_MANIFEST_VERSION;
  if (recorded?.kind !== 'pack-agent' && !(hadPack && legacy)) return; // not ours to manage

  const abs = join(projectRoot, rel);
  let installed: string;
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      if (recorded) newManifest.files[rel] = recorded; // never followed, never pruned
      return;
    }
    installed = readFileSync(abs, 'utf-8');
  } catch {
    return; // gone: nothing to keep
  }

  const edited = recorded?.kind === 'pack-agent' && !legacy
    ? isCustomizedAgent(installed, recorded.baselineSha)
    : !shippedShas.includes(agentBaselineSha(installed));
  const source = packsDir ? join(packsDir, 'agents', `${name}.md`) : null;
  if (edited || !source || !existsSync(source)) {
    if (recorded) newManifest.files[rel] = recorded; // the user's edit, or no package copy: leave it, keep it tracked
    if (edited && retiringNow && new RegExp(`^\\s*-\\s*${packName}\\s*$`, 'm').test(installed)) {
      result.notes.push(`Kept your edited ${rel}; it still lists the retired ${packName} skill under skills:, which no longer exists. Remove that line.`);
    }
    return;
  }
  const agent = installAgentForPlatform('claude', projectRoot, source, name);
  recordFile(newManifest, rel, dreamcontextVersion(), 'pack-agent', { baselineSha: agent.baselineSha });
}
