import { readSetupConfig } from './setup-config.js';

/**
 * Federation read gate. A vault is "shareable" iff its `.config.json` has
 * `shareable: true`. The default is FALSE (private by default — issue #25 LOCKED
 * decision): a brand-new or migrated project never exposes its corpus to peer
 * recall until the owner opts in with `dreamcontext config shareable on`.
 *
 * `shareable` gates READS only (whether a peer may pull this vault into a
 * cross-vault recall). It never gates whether THIS vault can read a shareable
 * peer, and it is never required to read the current vault's own corpus.
 *
 * Missing/malformed config ⇒ false (fail closed — never leak by accident).
 */
export function isShareable(projectRoot: string): boolean {
  const cfg = readSetupConfig(projectRoot);
  return cfg?.shareable === true;
}
