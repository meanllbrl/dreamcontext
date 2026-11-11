#!/usr/bin/env node
/**
 * The screens the owner sees when a member needs him (uye-bildirim criterion 15), shot in the real
 * flow of verify-owner-reach.mjs before each answer: the bar's member rows, the refusal card in the
 * member's chat, the member's profile Permissions. 1440 and 390 px, light and dark.
 *
 *   npm run build && node scripts/verify/look-owner-reach.mjs [out-folder]
 *
 * Default folder: tmp/verify/owner-reach/shots. The walk's own checks run too.
 */
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.OWNER_REACH_SHOTS = resolve(process.argv[2] || join(REPO, 'tmp', 'verify', 'owner-reach', 'shots'));
await import('./verify-owner-reach.mjs');
