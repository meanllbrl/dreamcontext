import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FileId } from '@excalidraw/excalidraw/element/types';
import { dataUrlBytes, isPictureOf, type BoardPictures, type PictureFile } from './boardPictures';
import { adoptImages, catchImages, decodeBitmap, makePreview, Sharpener, type Bitmap } from './pictureLod';

/** Previews decoded at once: each is a whole picture, and a board opens with all of them. */
const PREVIEW_LANES = 2;

/**
 * How a board's pictures reach the canvas: fetched, given a preview, added to Excalidraw in
 * batches, and sharpened when the view asks for more pixels (pictureLod.ts). Returns the call
 * that fetches the pictures in a list of elements that the canvas lacks.
 */
export function useBoardPictureLoader(
  apiRef: RefObject<ExcalidrawImperativeAPI | null>,
  picturesRef: RefObject<BoardPictures | undefined>,
): (elements: readonly unknown[]) => void {
  const retry = useRef<number | null>(null);
  const sharpenerRef = useRef<Sharpener | null>(null);

  // A rebuilt bitmap costs a new element object, same version and nonce: nothing to save, no
  // undo step. Never under a gesture, which holds the old object.
  const refreshPictures = useCallback((fileIds: readonly string[]) => {
    const api = apiRef.current;
    if (!api || !sharpenerRef.current?.active) return;
    const st = api.getAppState();
    if (st.cursorButton === 'down' || st.editingTextElement || st.croppingElementId) {
      retry.current = window.setTimeout(() => refreshPictures(fileIds), 300);
      return;
    }
    const ids = new Set(fileIds);
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((el) => (isPictureOf(el, ids) ? { ...el } : el)),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [apiRef]);

  const [sharpener] = useState(() => new Sharpener({
    decodeFull: async (image) => {
      const bytes = dataUrlBytes((image as HTMLImageElement).src);
      if (!bytes) throw new Error('not a data URL');
      return decodeBitmap(new Blob([bytes as BlobPart]));
    },
    refresh: (ids) => refreshPictures(ids),
  }));
  sharpenerRef.current = sharpener;

  const pending = useRef<{ data: BinaryFileData; preview: Bitmap | null }[]>([]);
  const flush = useRef<number | null>(null);
  const queue = useRef<PictureFile[]>([]);
  const lanes = useRef(0);
  /** Downloaded and not in the scene yet: a poll in between must not fetch them again. */
  const landing = useRef(new Set<string>());

  const addPending = useCallback(() => {
    flush.current = null;
    const batch = pending.current;
    pending.current = [];
    const api = apiRef.current;
    if (!api || batch.length === 0) return;
    try {
      const images = catchImages(() => api.addFiles(batch.map((f) => f.data)));
      const previews = new Map<string, { fileId: string; preview: Bitmap }>();
      for (const f of batch) if (f.preview) previews.set(f.data.dataURL, { fileId: f.data.id, preview: f.preview });
      adoptImages(images, previews, sharpener);
    } finally {
      for (const f of batch) landing.current.delete(f.data.id);
    }
  }, [apiRef, sharpener]);

  const runLane = useCallback(async () => {
    if (lanes.current >= PREVIEW_LANES) return;
    lanes.current += 1;
    try {
      for (let file = queue.current.shift(); file; file = queue.current.shift()) {
        const preview = file.blob ? await makePreview(file.blob) : null;
        pending.current.push({
          data: {
            id: file.id as FileId,
            mimeType: file.mimeType as BinaryFileData['mimeType'],
            dataURL: file.dataURL as DataURL,
            created: Date.now(),
          },
          preview,
        });
        // One scene update for pictures landing together, not one each.
        flush.current ??= requestAnimationFrame(addPending);
      }
    } finally {
      lanes.current -= 1;
    }
  }, [addPending]);

  const onPicture = useCallback((file: PictureFile) => {
    landing.current.add(file.id);
    queue.current.push(file);
    for (let i = 0; i < PREVIEW_LANES; i += 1) void runLane();
  }, [runLane]);

  useEffect(() => {
    sharpener.start();
    return () => {
      sharpener.dispose();
      if (retry.current !== null) clearTimeout(retry.current);
      if (flush.current !== null) cancelAnimationFrame(flush.current);
      retry.current = null;
      flush.current = null;
      pending.current = [];
      queue.current = [];
      landing.current.clear();
    };
  }, [sharpener]);

  return useCallback((elements: readonly unknown[]) => {
    const api = apiRef.current;
    const store = picturesRef.current;
    if (!api || !store) return;
    const held = api.getFiles();
    store.load(elements, (id) => !!held[id] || landing.current.has(id), onPicture);
  }, [apiRef, picturesRef, onPicture]);
}
