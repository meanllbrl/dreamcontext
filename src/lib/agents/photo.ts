import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXT_BY_IMAGE_TYPE, sniffImageType } from '../image-sniff.js';
import { automationPhotosDir, memberPhotoRoot, photoRelPathFor } from '../automations/store.js';
import { AutomationError } from '../automations/types.js';
import { safeWriteTarget } from '../vault-read.js';
import { isSafeAutomationSlug } from './slot.js';
import { globalAgentsDir, isGlobalAgentHere } from './scope.js';
import { getAgent } from './store.js';
import { assertOwned } from './owner.js';

/** An agent photo is a small square rendered at 56px at its largest. 4 MB is
 *  already absurdly generous for that and bounds what one manifest can pin
 *  into the brain directory. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/** A sniffed upload: the bytes and the extension their magic bytes earn. */
export interface ReceivedPhoto {
  buf: Buffer;
  ext: string;
}

/**
 * The photos folder of member `slug`: the brain's, or for the global agent here its home's
 * (`~/.dreamcontext/agents/<slug>/automations/photos/`, 0700 like the folder above it). A global
 * one is refused when any segment below the global agents folder is a link, so a write never
 * follows one out.
 */
function photosDirFor(contextRoot: string, slug: string): { dir: string; global: boolean } {
  const global = isGlobalAgentHere(contextRoot, slug);
  const dir = automationPhotosDir(memberPhotoRoot(contextRoot, slug));
  // Every file name this folder can hold for the slug, so a link at the exact file is refused too.
  if (global && !Object.values(EXT_BY_IMAGE_TYPE).every((ext) => safeWriteTarget(globalAgentsDir(), join(dir, `${slug}${ext}`)))) {
    throw new AutomationError('The global agent\'s photo goes through a link: remove the link and try again.');
  }
  return { dir, global };
}

/**
 * Write `<photos dir>/<slug><ext>` — every component constructed here, none of
 * it client-chosen — and return the photo-root-relative path for the `photo`
 * key (the same string for a project member and a global agent; only the root differs). An agent has exactly ONE photo file, so a new upload in a different
 * format takes the old one with it: otherwise `daily.png` lingers after
 * `daily.webp` replaces it, unreferenced and undeletable from the UI.
 */
export function storeAgentPhoto(contextRoot: string, slug: string, photo: ReceivedPhoto): string {
  if (!isSafeAutomationSlug(slug)) throw new AutomationError(`Invalid agent: ${slug}`);
  const rel = photoRelPathFor(slug, photo.ext);
  const { dir, global } = photosDirFor(contextRoot, slug);
  mkdirSync(dir, { recursive: true, ...(global ? { mode: 0o700 } : {}) });
  for (const otherExt of Object.values(EXT_BY_IMAGE_TYPE)) {
    if (otherExt === photo.ext) continue;
    try { unlinkSync(join(dir, `${slug}${otherExt}`)); } catch { /* never existed */ }
  }
  writeFileSync(join(dir, `${slug}${photo.ext}`), photo.buf);
  return rel;
}

/** Remove an agent's photo file(s), whatever the extension. */
export function removeAgentPhotoFiles(contextRoot: string, slug: string): void {
  if (!isSafeAutomationSlug(slug)) return;
  let dir: string;
  try { dir = photosDirFor(contextRoot, slug).dir; } catch { return; }
  for (const ext of Object.values(EXT_BY_IMAGE_TYPE)) {
    try { unlinkSync(join(dir, `${slug}${ext}`)); } catch { /* never existed */ }
  }
}

/**
 * Read an image the CLI was pointed at, under the upload route's rules: a
 * symlink is refused (lstat on the path itself), only a regular file within {@link MAX_PHOTO_BYTES},
 * and the type is the MAGIC BYTES' (no SVG), never the file name's.
 */
export function readPhotoFile(file: string): ReceivedPhoto {
  const abs = resolve(file);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new AutomationError(`No such file: ${file}`);
  }
  if (st.isSymbolicLink()) throw new AutomationError('A photo cannot be a symlink: point at the image file itself.');
  if (!st.isFile()) throw new AutomationError(`${file} is not a file.`);
  if (st.size === 0) throw new AutomationError('That file is empty.');
  if (st.size > MAX_PHOTO_BYTES) throw new AutomationError(`The photo exceeds the ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB limit.`);
  const buf = readFileSync(abs);
  const type = sniffImageType(buf);
  if (!type) throw new AutomationError('That file is not a PNG, JPEG, GIF or WebP image.');
  return { buf, ext: EXT_BY_IMAGE_TYPE[type] };
}

/** Checked BEFORE any photo file is written or removed: the agent exists and is this
 *  machine's owner's to edit. `updateAgent` checks the same, but only after the file write. */
export function assertCanSetPhoto(contextRoot: string, slug: string): void {
  const agent = getAgent(contextRoot, slug);
  if (!agent) throw new AutomationError(`No agent named "${slug}" in this project.`);
  assertOwned({ owner: agent.owner }, agent.title || slug);
}
