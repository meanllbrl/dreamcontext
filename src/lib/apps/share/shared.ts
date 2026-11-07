/**
 * Shared Apps (paylasilan-app-ler plan r2 K3; named so in app-paylasim-magaza r2): the signed-in account's repos that carry the
 * `dreamcontext-app` topic, split into what others shared with you and what you published, plus
 * invitations not accepted yet. Each app's name is read from its manifest (at most 30 reads a
 * refresh). Cached 15 minutes; a refresh is the owner's.
 */

import { homedir } from 'node:os';
import { listApps } from '../registry.js';
import { parseManifest } from '../manifest.js';
import { parseStoreReadme } from '../store-readme.js';
import { HostError, type AppHost, type Invitation } from './host.js';

export interface SharedApp {
  fullName: string;
  owner: string;
  name: string | null;
  description: string | null;
  /** The README's one line (its `tagline:` or first sentence), null when it has none. */
  tagline: string | null;
  public: boolean;
  pushedAt: string | null;
  /** The local slug when this project already has it installed. */
  installed?: string;
}

export interface SharedList {
  signedIn: boolean;
  login: string | null;
  host: 'github' | 'local';
  invitations: Invitation[];
  shared: SharedApp[];
  mine: SharedApp[];
  at: string;
  /** A rate limit or a refusal, said in plain words; the list is whatever was read before it. */
  problem?: string;
}

const TTL_MS = 15 * 60_000;
const MAX_MANIFEST_READS = 30;
const cache = new Map<string, { at: number; value: SharedList }>();
const names = new Map<string, { name: string | null; tagline: string | null }>();

export function clearSharedCache(): void { cache.clear(); names.clear(); }

export async function listShared(host: AppHost, opts: { force?: boolean; projectRoot?: string; home?: string } = {}): Promise<SharedList> {
  const empty = (login: string | null, problem?: string): SharedList => ({ signedIn: host.signedIn, login, host: host.kind, invitations: [], shared: [], mine: [], at: new Date().toISOString(), ...(problem ? { problem } : {}) });
  if (!host.signedIn) return empty(null);
  let login: string;
  try { login = (await host.me()).login; } catch (e) { return empty(null, e instanceof HostError ? e.message : 'GitHub did not answer'); }
  const key = `${host.kind}:${login}`;
  const hit = cache.get(key);
  let value: SharedList;
  if (!opts.force && hit && Date.now() - hit.at < TTL_MS) value = hit.value;
  else {
    value = empty(login);
    try {
      value.invitations = await host.listInvitations();
      const repos = await host.listAppRepos();
      let reads = 0;
      for (const r of repos) {
        if (!names.has(r.fullName) && reads < MAX_MANIFEST_READS) {
          reads++;
          const text = await host.getFile(r.fullName, 'dreamcontext-app.json').catch(() => null);
          const m = text ? parseManifest(text, null) : null;
          const readme = m && m.ok ? await host.getFile(r.fullName, 'README.md').catch(() => null) : null;
          names.set(r.fullName, { name: m && m.ok ? m.manifest.name : null, tagline: readme ? parseStoreReadme(readme.slice(0, 64 * 1024)).tagline : null });
        }
        const known = names.get(r.fullName);
        const row: SharedApp = { fullName: r.fullName, owner: r.owner, name: known?.name ?? null, description: r.description, tagline: known?.tagline ?? null, public: !r.private, pushedAt: r.pushedAt };
        if (r.owner === login) value.mine.push(row); else value.shared.push(row);
      }
    } catch (e) {
      value.problem = e instanceof HostError ? e.message : 'GitHub did not answer';
    }
    cache.set(key, { at: Date.now(), value });
  }
  if (!opts.projectRoot) return value;
  const installed = new Map(listApps(opts.home ?? homedir(), opts.projectRoot).filter((a) => a.origin === 'installed').map((a) => [a.source?.fullName ?? a.provenance?.fullName ?? '', a.slug]));
  return { ...value, shared: value.shared.map((s) => (installed.has(s.fullName) ? { ...s, installed: installed.get(s.fullName) } : s)) };
}
