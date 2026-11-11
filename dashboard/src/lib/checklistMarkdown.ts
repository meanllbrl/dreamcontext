/**
 * The checklist's submit message lives in src/lib/checklist-markdown.ts (sahip-karti-yerinde
 * K6), so the SERVER builds the receipt from the checklist's structured state with the very
 * function the window used. One module, no mirror to drift.
 *
 * A `wants:'secret'` item's masked value is not part of `ChecklistState` (checklistState.ts):
 * it is passed in separately as `secrets`, exactly once, at the moment of building the string.
 */
export {
  buildSubmitMarkdown, MAX_SUBMIT_BYTES, checklistReceiptForms, keptSecretMark, readChecklistSubmit,
  type ChecklistSubmitState,
} from '../../../src/lib/checklist-markdown.js';
