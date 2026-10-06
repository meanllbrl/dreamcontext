import { classifySaveFailure, reasonOf } from '../../hooks/whiteboardSaveLoop';

/**
 * A board's pictures in the page (owner, 2026-10-06: "free Excalidraw images, files stored in
 * the board's folder"). The scene holds an `image` element naming a `fileId`; the bytes live
 * beside the board on disk (`src/lib/whiteboards/files.ts`) and reach the page on their own
 * route, never inside a board body.
 *
 * Two directions, both keyed by file id:
 * - UP: a picture pasted or dropped onto the board is held by Excalidraw as a data URL. Before
 *   the save that first carries its element, its bytes go up. A refusal that cannot change
 *   (a type the board does not take, too large) is reported once and the picture is dropped
 *   from the scene; a failure that may pass (network, 5xx) throws, so the save loop retries.
 * - DOWN: an image element whose bytes the page does not hold (opened from disk, added by the
 *   CLI or another window) is fetched once and handed to Excalidraw.
 *
 * Injected I/O, no React and no Excalidraw import, so root vitest runs it as it is.
 */

/** The pictures a board stores, by type. The server reads the type from the bytes again. */
export const BOARD_PICTURE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export interface PictureFile {
  id: string;
  mimeType: string;
  dataURL: string;
}

export interface PictureDeps {
  /** Store a picture's bytes under its id; rejects with the HTTP status on a refusal. */
  upload: (id: string, bytes: Uint8Array, mimeType: string) => Promise<void>;
  /** Read a stored picture back as a data URL. */
  download: (id: string) => Promise<PictureFile>;
}

interface ImageLike {
  type?: unknown;
  isDeleted?: unknown;
  fileId?: unknown;
}

/** The file ids of the live pictures in `elements`, each once. */
export function liveFileIds(elements: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const raw of elements) {
    const el = raw as ImageLike | null;
    if (el && el.type === 'image' && el.isDeleted !== true && typeof el.fileId === 'string' && el.fileId) ids.add(el.fileId);
  }
  return [...ids];
}

/** True for an element that is a picture whose id is in `ids`. */
export function isPictureOf(raw: unknown, ids: ReadonlySet<string>): boolean {
  const el = raw as ImageLike | null;
  return !!el && el.type === 'image' && typeof el.fileId === 'string' && ids.has(el.fileId);
}

/** The bytes of a base64 data URL, or null for anything else. */
export function dataUrlBytes(dataURL: string): Uint8Array | null {
  const m = /^data:[^,;]*(?:;[^,;]*)*;base64,(.*)$/s.exec(dataURL);
  if (!m) return null;
  try {
    const bin = atob(m[1]!);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export class BoardPictures {
  /** On disk beside the board: never sent again. */
  private readonly stored = new Set<string>();
  /** Refused for good, with the reason the owner is told. */
  private readonly refused = new Map<string, string>();
  /** Bytes this page holds, so a save after the canvas is gone can still send them. */
  private readonly held = new Map<string, PictureFile>();
  private readonly loading = new Set<string>();
  /** Asked for and not there (deleted on disk): not asked again this open. */
  private readonly absent = new Set<string>();

  constructor(private readonly deps: PictureDeps) {}

  /** Ids the board already holds (it was loaded with them). */
  markStored(ids: Iterable<string>): void {
    for (const id of ids) this.stored.add(id);
  }

  /** Keep the page's picture data (Excalidraw's `getFiles()`), the copy a final save sends. */
  remember(files: Readonly<Record<string, { id?: unknown; mimeType?: unknown; dataURL?: unknown }>> | null | undefined): void {
    if (!files) return;
    for (const [id, f] of Object.entries(files)) {
      if (this.held.has(id) || this.stored.has(id)) continue;
      if (typeof f?.mimeType === 'string' && typeof f.dataURL === 'string') {
        this.held.set(id, { id, mimeType: f.mimeType, dataURL: f.dataURL });
      }
    }
  }

  /** Why a picture was refused, if it was. */
  refusal(id: string): string | undefined {
    return this.refused.get(id);
  }

  /**
   * Send every live picture in `elements` the board does not hold yet. Resolves with the ids
   * refused for good (the caller drops those pictures and says so); throws when a failure may
   * pass, so the save is retried. A picture whose bytes this page never had (another window's,
   * not loaded yet) is not this page's to send.
   */
  async uploadPending(elements: readonly unknown[]): Promise<string[]> {
    const refusedNow: string[] = [];
    for (const id of liveFileIds(elements)) {
      if (this.stored.has(id)) continue;
      if (this.refused.has(id)) {
        refusedNow.push(id);
        continue;
      }
      const file = this.held.get(id);
      if (!file) continue;
      const bytes = BOARD_PICTURE_TYPES.includes(file.mimeType) ? dataUrlBytes(file.dataURL) : null;
      if (!bytes) {
        this.refused.set(id, 'a board takes PNG, JPEG, GIF or WebP pictures only');
        refusedNow.push(id);
        continue;
      }
      try {
        await this.deps.upload(id, bytes, file.mimeType);
        this.stored.add(id);
        this.held.delete(id);
      } catch (err) {
        if (classifySaveFailure(statusOf(err)) !== 'terminal') throw err;
        this.refused.set(id, reasonOf(err));
        refusedNow.push(id);
      }
    }
    return refusedNow;
  }

  /**
   * Fetch every live picture in `elements` that `has` says the page lacks, one request at a
   * time per id, and hand what arrives to `onLoaded`. One missing on disk stays a placeholder.
   */
  load(elements: readonly unknown[], has: (id: string) => boolean, onLoaded: (file: PictureFile) => void): void {
    for (const id of liveFileIds(elements)) {
      if (has(id) || this.loading.has(id) || this.absent.has(id) || this.refused.has(id)) continue;
      // Ours and not sent yet: Excalidraw holds it, nothing to fetch.
      if (this.held.has(id)) continue;
      this.loading.add(id);
      this.deps.download(id).then(
        (file) => {
          this.stored.add(id);
          onLoaded(file);
        },
        // Gone on disk: a placeholder for good. Anything else (offline, busy) is asked again
        // on the next change or poll.
        (err) => { if (statusOf(err) === 404) this.absent.add(id); },
      ).finally(() => { this.loading.delete(id); });
    }
  }
}
