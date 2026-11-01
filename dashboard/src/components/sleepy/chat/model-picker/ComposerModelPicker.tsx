/**
 * The r29 picker in the composer (Track T W4): the part that reads the machine. Mounted only
 * while the menu is open, so the auto-switch flag and the favourites cost nothing otherwise.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi, useVault, emitInstance } from '../../../../context/VaultContext';
import { useClaudeAccounts } from '../../../../hooks/useAgentCapabilities';
import { onAgentSettings, patchAgentSettings, readAgentSettings } from '../../../../lib/agentSettings';
import type { AccountOption, ToolPick } from '../ComposerMenus';
import { ModelPicker, type SettingsTarget } from './ModelPicker';

export function ComposerModelPicker({ pick, model, effort, onModelChange, onEffortChange, accounts, activeAccountId, onAccountChange, newChatsLine, onSetDefault, savedDefault, close }: {
  pick: ToolPick;
  model: string;
  effort: string;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
  accounts: AccountOption[];
  activeAccountId: string;
  onAccountChange?: (id: string) => void;
  newChatsLine?: string;
  onSetDefault?: () => void;
  savedDefault: boolean;
  close: () => void;
}) {
  const api = useApi();
  const { bus } = useVault();
  const res = useClaudeAccounts(true);
  const [favourites, setFavourites] = useState<string[]>(() => readAgentSettings().modelFavourites);
  useEffect(() => onAgentSettings((cfg) => setFavourites(cfg.modelFavourites)), []);
  // Each tool keeps its own limit rules (account-rules.ts): a Codex chat's switch is Codex's.
  const codex = pick.current === 'codex';
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ['agent-account-rules'],
    queryFn: () => api.get<{ codex: { autoSwitch: boolean } }>('/agent/accounts/rules'),
    enabled: codex,
  });
  const autoSwitch = codex ? rules.data?.codex.autoSwitch : res.data?.autoSwitch;
  const toggleAutoSwitch = (): void => {
    if (codex) {
      void api.post('/agent/accounts/rules', { tool: 'codex', patch: { autoSwitch: !autoSwitch } })
        .then(() => qc.invalidateQueries({ queryKey: ['agent-account-rules'] }));
      return;
    }
    void api.post('/agent/accounts/auto-switch', { enabled: !autoSwitch }).then(() => res.refetch());
  };
  const openSettings = (target: SettingsTarget): void => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: target });

  return (
    <ModelPicker
      tools={pick.tools}
      currentTool={pick.current || 'claude'}
      model={model}
      effort={effort}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      onCrossTool={(m) => pick.onPick(m.tool === 'claude' ? '' : m.tool, m.id)}
      accounts={accounts}
      activeAccountId={activeAccountId}
      onAccountChange={onAccountChange}
      autoSwitch={autoSwitch === undefined ? undefined : {
        enabled: autoSwitch,
        onToggle: toggleAutoSwitch,
      }}
      favourites={favourites}
      onFavouritesChange={(keys) => { setFavourites(keys); void patchAgentSettings({ modelFavourites: keys }); }}
      newChatsLine={newChatsLine}
      onSetDefault={onSetDefault}
      savedDefault={savedDefault}
      onOpenSettings={openSettings}
      close={close}
    />
  );
}
