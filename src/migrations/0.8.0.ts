import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectionsPath, writeConnections, readConnections } from '../lib/connections.js';
import { ensureInbox, consumedDir } from '../lib/federation-inbox.js';
import { readSetupConfig, updateSetupConfig } from '../lib/setup-config.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.8.0: cross-project federation scaffolding (issue #25 P3.9).
 *
 * THREE idempotent scaffolds on the _dream_context root:
 *   1. `state/.connections.json` — created as `{version:1, connections:[]}` only
 *      if absent (an existing connections file is left untouched).
 *   2. `state/.federation-inbox/` + `consumed/` — created via `ensureInbox`.
 *   3. `shareable: false` — set ONLY when currently UNDEFINED, written through
 *      `updateSetupConfig` (merge), so an explicit `shareable: true` is NEVER
 *      clobbered (SECURITY AMENDMENT 2, binding).
 *
 * All three are idempotent: a second run detects everything already present and
 * touches nothing. `detected: true` iff no file was written/created.
 *
 * Version key is 0.8.0 — the assumed next release in which federation ships.
 */
export const migration080: Migration = {
  version: '0.8.0',
  steps: [
    (root: string): MigrationStepResult => {
      const projectRoot = dirname(root);
      const filesTouched: string[] = [];

      // 1. Scaffold .connections.json only if absent.
      const connPath = connectionsPath(root);
      if (!existsSync(connPath)) {
        writeConnections(root, { version: 1, connections: [] });
        filesTouched.push('state/.connections.json');
      } else {
        // Touch nothing — but normalise-read to confirm it is well-formed.
        readConnections(root);
      }

      // 2. Scaffold the inbox tree (.federation-inbox/ + consumed/).
      const inboxExisted = existsSync(consumedDir(root));
      ensureInbox(root);
      if (!inboxExisted) {
        filesTouched.push('state/.federation-inbox/', 'state/.federation-inbox/consumed/');
      }

      // 3. Default shareable:false ONLY if currently undefined (never clobber true).
      const cfg = readSetupConfig(projectRoot);
      let shareableTouched = false;
      if (cfg && cfg.shareable === undefined) {
        updateSetupConfig(projectRoot, { shareable: false });
        filesTouched.push('state/.config.json (shareable:false)');
        shareableTouched = true;
      }

      const detected = filesTouched.length === 0;
      const summary = detected
        ? 'Federation already scaffolded (.connections.json + .federation-inbox/ present, shareable set) — nothing to do.'
        : `Scaffolded federation: ${filesTouched.join(', ')}` +
          (shareableTouched ? '' : (cfg ? ' (shareable already set — preserved)' : ''));

      return {
        step: 'scaffold-federation',
        filesTouched: filesTouched.map((f) => join(root, f.split(' ')[0])),
        summary,
        detected,
      };
    },
  ],
};
