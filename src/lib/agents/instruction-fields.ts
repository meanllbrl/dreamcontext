import type { ApprovalPayloadFields } from '../automations/types.js';

/**
 * WHICH SIDE OF THE LINE EACH MEMBER FIELD SITS ON. The one place that says it.
 *
 *  - `instruction`: text that tells the member how to do the job it already has. The Super Agent
 *    may change it from its own session (`super team amend`), the member stays approved, and the
 *    change leaves a trace the owner can undo.
 *  - `authority`: anything that widens what the member may touch, where its work lands, who sees
 *    it, when it runs alone, or that removes a human gate. Only the owner changes these; a change
 *    from anywhere else keeps asking.
 *
 * Pure: no I/O, importable by the server, the CLI and the tests alike.
 */
export type FieldSide = 'instruction' | 'authority';

/**
 * Every approval-hashed field, classified. `satisfies` makes this exhaustive against the review
 * list at compile time, and `instruction-fields.test.ts` holds it against what
 * `canonicalApprovalPayload` really hashes: a field added to the hash fails until someone decides
 * which side it is on. Anything not listed here is `authority`.
 *
 * `outputInstructions` is text, and still `authority`: it says where else the output goes.
 * `readTools` is which MCP tools a light job may use: it widens what the member reaches, so only the owner changes it.
 * `app` is the app a job belongs to: it decides which app's brief the run gets.
 * `mode` is hashed but not in the review list: `sched` is what lets a member run alone.
 */
export const HASHED_FIELD_SIDE = {
  prompt: 'instruction',
  soul: 'instruction',
  job: 'instruction',
  outputInstructions: 'authority',
  model: 'authority',
  effort: 'authority',
  timeoutMinutes: 'authority',
  outputDir: 'authority',
  learning: 'authority',
  review: 'authority',
  flow: 'authority',
  whiteboard: 'authority',
  autonomy: 'authority',
  readTools: 'authority',
  app: 'authority',
  mode: 'authority',
} as const satisfies Record<keyof ApprovalPayloadFields | 'mode', FieldSide>;

/**
 * What the approval hash does not cover, and so what no amendment can reach either. Each has its
 * own owner verb. Named here so the table in the docs is this file, not a second opinion.
 */
export const UNHASHED_AUTHORITY_FIELDS = ['schedule', 'enabled', 'shared', 'notify', 'catchupHours', 'tools', 'permissions'] as const;

/** Never authority: how a member is drawn and remembered. Unhashed, free to change. */
export const UNHASHED_NEUTRAL_FIELDS = ['title', 'photo', 'face', 'reportsTo', 'team', 'pattern'] as const;

export type InstructionField = {
  [K in keyof typeof HASHED_FIELD_SIDE]: (typeof HASHED_FIELD_SIDE)[K] extends 'instruction' ? K : never;
}[keyof typeof HASHED_FIELD_SIDE];

/** The fields an amendment may write. Derived from the table, so it cannot drift from it. */
export const INSTRUCTION_FIELDS = (Object.keys(HASHED_FIELD_SIDE) as (keyof typeof HASHED_FIELD_SIDE)[])
  .filter((f) => HASHED_FIELD_SIDE[f] === 'instruction') as readonly InstructionField[];

/** True for an amendable field. Anything unknown is `authority`: the safe side. */
export function isInstructionField(field: string): field is InstructionField {
  return Object.prototype.hasOwnProperty.call(HASHED_FIELD_SIDE, field)
    && HASHED_FIELD_SIDE[field as keyof typeof HASHED_FIELD_SIDE] === 'instruction';
}
