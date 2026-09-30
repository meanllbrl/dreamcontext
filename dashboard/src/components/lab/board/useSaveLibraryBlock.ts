import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RequestError } from '../../../api/client';
import { useApi } from '../../../context/VaultContext';
import type { LibraryBlock } from './boardTypes';
import type { LibraryPutRequest } from './editorModel';

/**
 * Save a custom HTML block to the vault library (`PUT /api/lab/blocks/:slug`).
 * The library list (`['lab', 'blocks']`, shared with `useBlockLibrary` and
 * every `HtmlBlock` that renders by ref) is updated in place with the saved
 * entry, so a card switched to `ref` renders it without a refetch.
 *
 * Failures come back as a kind the dialog can word: `conflict` (409, the entry
 * changed since it was read), `invalid` (400, the server's problems) or
 * `failed` (network / 5xx).
 */

export type LibrarySaveError = { kind: 'conflict' | 'invalid' | 'failed'; message: string };

export function librarySaveError(err: unknown): LibrarySaveError {
  if (err instanceof RequestError) {
    if (err.status === 409) return { kind: 'conflict', message: err.message };
    if (err.status === 400) return { kind: 'invalid', message: err.message };
  }
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
}

export function useSaveLibraryBlock() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: LibraryPutRequest) => api.put<{ block: LibraryBlock }>(req.path, req.body).then((r) => r.block),
    onSuccess: (block) => {
      queryClient.setQueryData<LibraryBlock[]>(['lab', 'blocks'], (prev) => {
        const rest = (prev ?? []).filter((b) => b.slug !== block.slug);
        return [...rest, block].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
      });
    },
  });
}
