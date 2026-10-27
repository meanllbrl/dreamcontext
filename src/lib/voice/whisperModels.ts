/**
 * The local speech models this app offers, what each costs, and which one fits THIS machine.
 *
 * ── WHY THIS EXISTS (owner, 2026-10-27) ────────────────────────────────────────────────
 * Turning voice on used to download `large-v3-turbo` with no question asked, and every time the
 * assistant opened it was loaded into memory. On a MacBook Air with 8 GB that took dreamcontext
 * down: the model alone wants ~2 GB of resident memory before beam search, on a machine where
 * the app's own webviews, its server and the Claude sessions already share 8 GB. So the size
 * is now the owner's choice, and the default is a size the machine can carry.
 *
 * The numbers are whisper.cpp's own (README "Memory usage" table: disk / resident memory for
 * the f16 ggml files); `large-v3-turbo` is not in that table, so its memory is the encoder of
 * large-v3 with a 4-layer decoder, ESTIMATED at about 2.2 GB (not measured here). They are
 * shown to the owner as approximate, and used here only to refuse a load that cannot fit.
 */

import { cpus, totalmem } from 'node:os';

export type WhisperModelId = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

export interface WhisperModelSpec {
  id: WhisperModelId;
  /** The ggml file whisper.cpp's mirror serves under this name. */
  file: string;
  /** Download size, MB. */
  downloadMB: number;
  /** Resident memory while loaded, MB (approximate). */
  ramMB: number;
}

/** Smallest first. The order is also the fallback order for "the biggest that fits". */
export const WHISPER_MODELS: readonly WhisperModelSpec[] = [
  { id: 'tiny', file: 'ggml-tiny.bin', downloadMB: 75, ramMB: 390 },
  { id: 'base', file: 'ggml-base.bin', downloadMB: 142, ramMB: 500 },
  { id: 'small', file: 'ggml-small.bin', downloadMB: 466, ramMB: 1000 },
  { id: 'medium', file: 'ggml-medium.bin', downloadMB: 1530, ramMB: 2100 },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', downloadMB: 1620, ramMB: 2200 },
];

export const MODEL_URL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export function modelSpec(id: string | undefined | null): WhisperModelSpec | null {
  return WHISPER_MODELS.find((m) => m.id === id) ?? null;
}

export function isWhisperModelId(id: unknown): id is WhisperModelId {
  return typeof id === 'string' && WHISPER_MODELS.some((m) => m.id === id);
}

export interface MachineInfo {
  /** Total physical memory, bytes. */
  memBytes: number;
  /** The CPU's marketing name (`Apple M2 Pro`, `Intel(R) Core(TM) i5…`). */
  cpuModel: string;
  cores: number;
}

/** This machine. A test passes its own. */
export function machineInfo(): MachineInfo {
  const list = cpus() ?? [];
  return { memBytes: totalmem(), cpuModel: list[0]?.model ?? '', cores: list.length || 1 };
}

const GB = 1024 ** 3;

/** An Apple chip of the Pro/Max/Ultra class: more memory bandwidth and GPU, so the large model
 *  runs in real time there even at 16 GB. */
export function isHighEndChip(cpuModel: string): boolean {
  return /\bApple\b.*\b(Pro|Max|Ultra)\b/i.test(cpuModel);
}

/**
 * The size to recommend.
 *
 *   ≤ 6 GB                        → base
 *   ≤ 8 GB  (every base MacBook Air) → small
 *   ≤ 16 GB, ordinary chip       → medium
 *   32 GB+, or 16 GB+ on a Pro/Max/Ultra → large-v3-turbo
 *
 * Rounded up by half a gigabyte because `totalmem()` reports a little under the label.
 */
export function recommendModel(m: MachineInfo = machineInfo()): WhisperModelId {
  const gb = m.memBytes / GB + 0.5;
  if (gb <= 6.5) return 'base';
  if (gb <= 8.5) return 'small';
  if (gb >= 31.5 || (gb >= 15.5 && isHighEndChip(m.cpuModel))) return 'large-v3-turbo';
  return 'medium';
}

/**
 * The share of physical memory one dictation model may take. A quarter: on 8 GB that is 2 GB,
 * which keeps `small` and refuses `medium`/`large-v3-turbo` — exactly the loads that took the
 * app down. On 16 GB every model fits.
 */
export const MAX_MODEL_MEM_SHARE = 0.25;

/** Can this machine carry `ramMB` of model without starving the app around it? */
export function fitsMachine(ramMB: number, m: MachineInfo = machineInfo()): boolean {
  return ramMB * 1024 * 1024 <= m.memBytes * MAX_MODEL_MEM_SHARE;
}

/**
 * The memory a model file needs: the table's number for a known file, else the file's size
 * times 1.4 (weights plus the decoder's working buffers) for one this app does not know.
 */
export function ramForModelFile(fileName: string, sizeBytes: number): number {
  const known = WHISPER_MODELS.find((m) => m.file === fileName);
  if (known) return known.ramMB;
  if (/large-v3\.bin$|large\.bin$/.test(fileName)) return 3900;
  return Math.round((sizeBytes * 1.4) / (1024 * 1024));
}
