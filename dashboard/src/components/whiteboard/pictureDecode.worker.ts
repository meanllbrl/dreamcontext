/**
 * Decodes pictures away from the page. WebKit, the desktop app's engine, runs a page-side
 * `createImageBitmap(blob)` on the main thread (measured: 0-2 heartbeats per decode); in a
 * worker it does not.
 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; blob: Blob; options?: ImageBitmapOptions }>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = async ({ data: { id, blob, options } }) => {
  try {
    const bitmap = await createImageBitmap(blob, options);
    scope.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
