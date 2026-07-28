import { dirname, resolve, sep } from 'node:path';
import { redactSecrets } from '../credentials.js';
import { runScriptInChild } from './script-child.js';
import { isRawFunnelSet, LabError, type AdapterContext, type AdapterResult, type InsightManifest, type LabAdapter, type RawSeries, type SeriesPoint } from '../types.js';

/**
 * Custom-script adapter — the escape hatch for anything the declarative HTTP
 * adapter can't express.
 *
 * TRUST MODEL (accepted, documented — see the task doc + skill docs): a
 * `lab/scripts/*.mjs` is user/agent-authored LOCAL code at the same trust level
 * as the repo itself. It runs in a SHORT-LIVED CHILD PROCESS (see
 * `script-child.ts`) with credentials handed over on stdin (never persisted or
 * logged by this runner). The child is an isolation boundary for correctness and
 * blast radius, NOT a sandbox: it has the same user, filesystem, and network
 * access as the host. There is no sandbox in MVP; the mitigations are (a) this
 * plain statement and (b) the sync engine's script-hash change tripwire, which
 * prints a loud notice before executing a script that changed since the last run.
 * Anyone with brain-repo push access can change what runs on a peer machine at
 * the next lab sync — review before first sync.
 */

/** Absolute path of the script file for a manifest (contained under `lab/`). */
export function scriptFilePath(manifest: InsightManifest): string {
  const source = manifest.source;
  if (!source || source.adapter !== 'script') {
    throw new LabError('Custom-script adapter requires a `script` source.');
  }
  // manifest.path = <ctx>/lab/insights/<slug>.md → labDir is two dirs up.
  const labRoot = dirname(dirname(manifest.path));
  const abs = resolve(labRoot, source.file);
  if (abs !== labRoot && !abs.startsWith(labRoot + sep)) {
    throw new LabError(`Script path escapes lab/: ${source.file}`);
  }
  return abs;
}

function coerceSeries(result: unknown): RawSeries[] {
  if (!Array.isArray(result)) {
    throw new LabError('Custom script must return an array of { name, points } series, or a { kind: "funnel-set/v1", … } funnel payload for `render: funnel`.');
  }
  return result.map((s, i) => {
    const r = s as { name?: unknown; points?: unknown };
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim() : `series-${i}`;
    if (!Array.isArray(r?.points)) {
      throw new LabError(`Custom script series "${name}" has no points array.`);
    }
    const points: SeriesPoint[] = r.points.map((p) => {
      const pt = p as { t?: unknown; v?: unknown };
      return { t: String(pt?.t ?? ''), v: Number(pt?.v) };
    });
    return { name, points };
  });
}

export const customScriptAdapter: LabAdapter = {
  async fetch(ctx: AdapterContext): Promise<AdapterResult> {
    const abs = scriptFilePath(ctx.manifest);
    const secretValues = Object.values(ctx.credentials);
    const file = ctx.manifest.source && 'file' in ctx.manifest.source ? ctx.manifest.source.file : 'script';
    try {
      // A fresh process per run — the ONLY way a shared `lab/scripts/lib-*.mjs`
      // edit is guaranteed to be seen (GitHub #242; see script-child.ts).
      const result = await runScriptInChild(abs, ctx, file);
      // A funnel-set payload passes through raw — the ENGINE validates + caps it
      // (parseFunnelSet), keeping the trust/validation boundary in one place.
      if (isRawFunnelSet(result)) return result;
      return coerceSeries(result);
    } catch (err) {
      if (err instanceof LabError) throw new LabError(redactSecrets(err.message, secretValues));
      const raw = err instanceof Error ? err.message : String(err);
      throw new LabError(redactSecrets(`Custom script ${file} threw: ${raw}`, secretValues));
    }
  },
};
