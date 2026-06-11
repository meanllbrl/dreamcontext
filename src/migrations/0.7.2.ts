import { detectFlatDiagramBoards } from '../lib/diagrams-migration.js';
import type { Migration, MigrationStepResult } from './types.js';

/**
 * Migration 0.7.2: Excalidraw knowledge boards — diagrams folder convention.
 *
 * CODE step: SAFE DETECTION ONLY.
 * Scans knowledge/diagrams/ for flat *.excalidraw.md boards and records how
 * many were detected. Does NOT move any files — respects #20's explicit
 * out-of-scope decision: "auto-migrating flat layouts into per-title folders
 * silently breaks slugs/wikilinks/access-records on every update/sleep."
 *
 * The actual move+rewriteWikilinks logic lives in src/lib/diagrams-migration.ts
 * and is exposed ONLY via the agentTask below (opt-in, user judgment required).
 *
 * agentTask: MigrationAgentTask — informs the user that flat boards exist and
 * explains the opt-in reorganization available. The user decides when/whether
 * to adopt the per-title folder convention.
 */
export const migration072: Migration = {
  version: '0.7.2',
  steps: [
    // Step: detect flat boards, record count — MOVE NOTHING.
    (root: string): MigrationStepResult => {
      const flatBoards = detectFlatDiagramBoards(root);
      const detected = true; // always "detected" — we never move in the code step
      const summary =
        flatBoards.length > 0
          ? `Detected ${flatBoards.length} flat diagram board(s) in knowledge/diagrams/: ${flatBoards.join(', ')}. ` +
            'No files moved. To opt-in: run `dreamcontext migrations apply-diagrams` after confirming which boards are canonical knowledge.'
          : 'No flat diagram boards found in knowledge/diagrams/ — nothing to do.';
      return {
        step: 'detect-flat-diagram-boards',
        filesTouched: [], // code step moves nothing
        summary,
        detected,
      };
    },
  ],
  agentTask: {
    id: 'diagrams-folder-convention',
    instruction:
      'Opt-in: organize Excalidraw boards into knowledge/diagrams/<title>/ per-title folders. ' +
      'STEP 1 — Behavioral judgment (do this BEFORE running any command): ' +
      'Only boards that are canonical, durable knowledge (architecture diagrams, system flows, roadmaps, ' +
      'plans the agent should recall in future sessions) belong in knowledge/diagrams/. ' +
      'Temporary / scratch / exploratory / in-progress sketches belong in inbox/ or workspace/ ' +
      '(dark by location — NOT indexed, will not pollute recall). ' +
      'Decision rule: "Will a future session need to know this? → keep in knowledge. Throwaway/working? → inbox/workspace." ' +
      'Do NOT pull temp/scratch boards into knowledge/diagrams/. ' +
      'STEP 2 — For boards confirmed canonical, run: dreamcontext migrations apply-diagrams ' +
      '(this command moves board+generator+spec into knowledge/diagrams/<title>/ AND rewrites all ' +
      'inbound [[wikilinks]] atomically — do NOT hand-edit wikilinks manually). ' +
      'Never run generator scripts. Never edit scene JSON. ' +
      'Flat boards already index and recall correctly via suffix detection — only adopt this convention when the user explicitly requests it. ' +
      'STEP 3 — Verify the ledger entry was recorded (the apply-diagrams command records it automatically). ' +
      'Use dreamcontext migrations pending to see this task; run dreamcontext migrations apply-diagrams to opt-in to organizing flat boards.',
  },
};
