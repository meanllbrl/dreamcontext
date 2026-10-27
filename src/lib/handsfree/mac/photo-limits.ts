/**
 * The hands-free phone's photo upload caps (task hands-free-phone-shows-every-picture…, D5).
 *
 * `POST /api/agent/drop` takes a photo from the phone over a public tunnel, so it gets caps of its
 * own, kept per DEVICE (`deviceIdHash`) rather than per socket — a phone that reconnects does not
 * start a fresh allowance:
 *   • a photo of at most {@link PHONE_MAX_PHOTO_BYTES} (the phone re-encodes to a 2560 px JPEG,
 *     typically 0.4-1.5 MB, so this is room, not a target), any other file of at most
 *     {@link PHONE_MAX_FILE_BYTES};
 *   • two uploads in flight and thirty a minute per device (six photos per message, sent at once);
 *   • at most {@link PHONE_DROPS_MAX_BYTES} of phone photos in one project's drop folder.
 * The gate is taken BEFORE the body is read, so a burst is refused without buffering it.
 */

import { VoiceGate, type GateVerdict } from '../../voice/limits.js';

export const PHONE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Any other file from the phone (a zip, a PDF, a text file): stored as its bytes, never opened
 *  or extracted, at most this big — the desktop drop's own 25 MB. Mirrored in the dashboard
 *  (`PHONE_MAX_FILE_BYTES`, lib/phoneAttach.ts); tests/unit/phone-attach.test.ts holds them equal. */
export const PHONE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const PHONE_DROPS_MAX_BYTES = 500 * 1024 * 1024;
export const PHONE_PHOTO_LIMITS = { concurrency: 2, perWindow: 30, windowMs: 60_000 } as const;
/** The file-name prefix every phone photo carries in the drop folder (counted by the cap). */
export const PHONE_PHOTO_PREFIX = 'phone-';

const MAX_DEVICES = 64;
const gates = new Map<string, VoiceGate>();

/** Take a slot for `device`. On `'ok'` the caller MUST call {@link releasePhonePhoto}. */
export function acquirePhonePhoto(device: string, now: number = Date.now()): GateVerdict {
  let gate = gates.get(device);
  if (!gate) {
    // Bounded: drop the oldest device's gate (an idle one; a busy one is at most two uploads).
    if (gates.size >= MAX_DEVICES) gates.delete(gates.keys().next().value as string);
    gate = new VoiceGate({ ...PHONE_PHOTO_LIMITS });
    gates.set(device, gate);
  }
  return gate.acquire(now);
}

export function releasePhonePhoto(device: string): void {
  gates.get(device)?.release();
}

/** Tests only. */
export function resetPhonePhotoGates(): void {
  gates.clear();
}
