/**
 * The shape of a scorecard run key (`[<projectKey>/]<source>::<runId>`), in a module with no
 * imports: the Super record's sanitizer (`super/store.ts`) checks `rateRun` with it without pulling
 * the scorecard store, the owner guard and the model judge into the record's import graph.
 */
export const RUN_KEY_RE = /^([0-9a-f]{16}\/)?[a-z0-9-]+::[0-9A-Za-z:.\-]+$/;

export function isRunKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= 300 && RUN_KEY_RE.test(key);
}
