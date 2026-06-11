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
            'No files moved. Use the agentTask to opt-in to per-title folder organization.'
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
      'For each flat knowledge/diagrams/<title>.excalidraw.md board: ' +
      '(1) create knowledge/diagrams/<title>/, ' +
      '(2) move the board + any unambiguous same-basename generator/spec files (.board.cjs/.board.js/.board.py/.json) into it, ' +
      '(3) call rewriteWikilinks atomically after each move (old slug diagrams/<title>.excalidraw → new slug diagrams/<title>/<title>.excalidraw) so all inbound [[wikilinks]] in .md files under contextRoot stay valid. ' +
      'Never run generator scripts. Never edit scene JSON. ' +
      'Flat boards already index and recall correctly via suffix detection — only adopt this convention when the user explicitly requests it.',
  },
};
