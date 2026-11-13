/**
 * The old excalidraw pack's builder exactly as 0.41.x shipped it, FROZEN in
 * tests/fixtures/old-excalidraw/build_excalidraw.js. It used to be rebuilt from today's
 * skill-draw builder (only the command block differed), which broke the moment the draw
 * builder moved on (0.41.20: spec screens take items) while users' old copies did not.
 * Tests check it against the retired pack's shipped table, so a wrong fixture fails loudly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(__dirname, '..', 'fixtures', 'old-excalidraw', 'build_excalidraw.js');

export function oldBuilder(): string {
  return readFileSync(FIXTURE, 'utf-8');
}
