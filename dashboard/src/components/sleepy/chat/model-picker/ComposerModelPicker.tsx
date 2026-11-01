/**
 * The r29 picker in the composer (Track T W4): the part that reads the machine. Mounted only
 * while the menu is open, so the auto-switch flag costs nothing otherwise.
 */
import { useApi, useVaultId, emitInstance } from '../../../../context/VaultContext';
import { useClaudeAccounts } from '../../../../hooks/useAgentCapabilities';
import { OPEN_TOOL_CHAT_EVENT, type OpenToolChatDetail } from '../../../../lib/chatToolBinding';
import { useEmbed } from '../../../embed/embedMode';
import type { AccountOption, ToolPick } from '../ComposerMenus';
import { ModelPicker, type SettingsTarget } from './ModelPicker';
import { effortsFor } from './pickerModel';

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
  const { bus } = useVaultId();
  // An embed has no chat surface to open a new chat in.
  const embedded = !!useEmbed();
  const res = useClaudeAccounts(true);
  const autoSwitch = res.data?.autoSwitch;
  const openSettings = (target: SettingsTarget): void => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'settings', id: target });

  // A version without this chat's effort lands on one it has: the CLI would take the old value
  // silently, and the chip would name a level that model does not run.
  const changeModel = (id: string): void => {
    const own = pick.tools.find((t) => t.tool === (pick.current || 'claude'));
    const levels = own ? effortsFor(own, id) : [];
    if (levels.length > 0 && !levels.includes(effort)) onEffortChange(levels.includes('high') ? 'high' : levels[levels.length - 1]!);
    onModelChange(id);
  };

  return (
    <ModelPicker
      tools={pick.tools}
      currentTool={pick.current || 'claude'}
      model={model}
      effort={effort}
      onModelChange={changeModel}
      onEffortChange={onEffortChange}
      onCrossTool={(m) => pick.onPick(m.tool === 'claude' ? '' : m.tool, m.id)}
      lock={pick.lock && {
        ...pick.lock,
        onOpen: embedded ? undefined : (tool) => { if (tool === 'codex') emitInstance<OpenToolChatDetail>(bus, OPEN_TOOL_CHAT_EVENT, { tool }); },
      }}
      accounts={accounts}
      activeAccountId={activeAccountId}
      onAccountChange={onAccountChange}
      autoSwitch={autoSwitch === undefined ? undefined : {
        enabled: autoSwitch,
        onToggle: () => { void api.post('/agent/accounts/auto-switch', { enabled: !autoSwitch }).then(() => res.refetch()); },
      }}
      newChatsLine={newChatsLine}
      onSetDefault={onSetDefault}
      savedDefault={savedDefault}
      onOpenSettings={openSettings}
      close={close}
    />
  );
}
