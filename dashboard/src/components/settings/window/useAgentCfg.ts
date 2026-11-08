import { useEffect, useState } from 'react';
import {
  initAgentSettingsFromServer,
  isAgentSettingsHydrated,
  onAgentSettings,
  patchAgentSettings,
  retryAgentSettingsNow,
  type AgentSettings,
} from '../../../lib/agentSettings';

/**
 * The machine's agent settings for the Settings window: seeded from the server, then
 * tracking every writer (this window, the chat's own menus, another window). Each control
 * sends only its own field (`patchAgentSettings`), so nothing stale is spread back.
 */
export function useAgentCfg(): {
  cfg: AgentSettings | null;
  loadFailed: boolean;
  update: (patch: Partial<AgentSettings>) => Promise<boolean>;
  retry: () => void;
} {
  const [cfg, setCfg] = useState<AgentSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void initAgentSettingsFromServer().then((s) => {
      if (!live) return;
      setCfg(s);
      setLoadFailed(!isAgentSettingsHydrated());
    });
    const off = onAgentSettings((next) => {
      setCfg(next);
      if (isAgentSettingsHydrated()) setLoadFailed(false);
    });
    return () => { live = false; off(); };
  }, []);
  const update = async (patch: Partial<AgentSettings>): Promise<boolean> => {
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev));
    const r = await patchAgentSettings(patch);
    return r.ok;
  };
  const retry = () => { void retryAgentSettingsNow().then(() => setLoadFailed(!isAgentSettingsHydrated())); };
  return { cfg, loadFailed, update, retry };
}
