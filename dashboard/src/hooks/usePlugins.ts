import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { readScoped, writeScoped } from '../lib/scopedStorage';
import { pluginStateIn, type PluginState, type PluginsView } from '../lib/plugins';

/**
 * The project's installed plugins (Mağaza D1, C7). Reads `GET /api/plugins` every 15 s and on
 * window focus, so a teammate's install that arrived with a pull shows up without a reload.
 *
 * `set` is the last successful answer, cached per vault in scoped storage and used while loading
 * or after an error; `null` only when this vault never loaded one. Consumers ask
 * {@link usePlugins}'s `pluginState(id)`: `unknown` (no set) is never "not installed", so a
 * failing route never hides a page.
 */
export const PLUGINS_KEY = 'plugins';
const CACHE_KEY = 'dreamcontext.plugins.lastSet';

function validView(v: unknown): v is PluginsView {
  return !!v && typeof v === 'object' && Array.isArray((v as PluginsView).plugins);
}

export function usePlugins() {
  const api = useApi();
  const { vault } = useVault();
  const q = useQuery({
    queryKey: [PLUGINS_KEY, vault],
    queryFn: () => api.get<PluginsView>('/plugins'),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  useEffect(() => {
    if (validView(q.data)) writeScoped(vault, CACHE_KEY, q.data);
  }, [q.data, vault]);
  const cached = validView(q.data) ? q.data : (() => {
    const c = readScoped<unknown>(vault, CACHE_KEY, null);
    return validView(c) ? c : null;
  })();
  const status: 'loading' | 'ready' | 'error' = q.isSuccess ? 'ready' : q.isError ? 'error' : 'loading';
  const pluginState = useCallback((id: string): PluginState => pluginStateIn(cached, id), [cached]);
  return { status, set: cached, pluginState, refetch: q.refetch };
}

/** Install, remove and pin. Every answer is the fresh `GET /api/plugins` view; the rest of the
 *  app (pages, snapshot-fed panels) is refetched because a plugin changes what they show. */
export function usePluginActions() {
  const api = useApi();
  const { vault } = useVault();
  const qc = useQueryClient();
  const settle = (view: PluginsView | undefined) => {
    if (validView(view)) {
      qc.setQueryData([PLUGINS_KEY, vault], view);
      writeScoped(vault, CACHE_KEY, view);
    }
    void qc.invalidateQueries();
  };
  const install = useMutation({
    mutationFn: (id: string) => api.post<PluginsView>(`/plugins/${encodeURIComponent(id)}/install`, {}),
    onSuccess: settle,
    onError: () => { void qc.invalidateQueries({ queryKey: [PLUGINS_KEY, vault] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.post<PluginsView>(`/plugins/${encodeURIComponent(id)}/remove`, {}),
    onSuccess: settle,
    onError: () => { void qc.invalidateQueries({ queryKey: [PLUGINS_KEY, vault] }); },
  });
  const pins = useMutation({
    mutationFn: (pinned: string[]) => api.put<PluginsView>('/plugins/pins', { pinned }),
    onSuccess: (view) => {
      if (validView(view)) {
        qc.setQueryData([PLUGINS_KEY, vault], view);
        writeScoped(vault, CACHE_KEY, view);
      }
    },
  });
  return { install, remove, pins };
}
