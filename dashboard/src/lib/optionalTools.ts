/**
 * Settings → System → "Optional tools" (owner 2026-11-03): Codex and Antigravity are NOT
 * dependencies. Everything runs on Claude without them, so their absence never reads as an
 * error: a missing, signed-out or outdated tool is a gray dot and a neutral button, never red,
 * never amber, never a warning icon. Pure, so the tone rules are pinned by a test.
 */
import type { AgentToolInfo, ToolAccountWire } from '../hooks/useAgentCapabilities';
import type { FixId } from './onboardingTypes';

export type OptionalTool = 'codex' | 'antigravity';
/** The only two tones this card draws. */
export type OptionalTone = 'ok' | 'muted';

export interface OptionalRowModel {
  tone: OptionalTone;
  statusKey: string;
  /** The one-click fix the row's neutral button starts, if any. */
  action: { fix: FixId; labelKey: string } | null;
}

export interface OptionalToolModel {
  tool: OptionalTool;
  name: string;
  descKey: string;
  install: OptionalRowModel;
  /** The account row under an installed tool; null while it is not installed. */
  account: OptionalRowModel | null;
}

const NAMES: Record<OptionalTool, string> = { codex: 'Codex', antigravity: 'Antigravity' };

export function optionalToolModel(tool: OptionalTool, info: AgentToolInfo | undefined): OptionalToolModel {
  const base = { tool, name: NAMES[tool], descKey: `settings.optional.${tool}.desc` };
  if (!info || !info.installed) {
    return {
      ...base,
      install: { tone: 'muted', statusKey: 'settings.optional.notInstalled', action: { fix: `${tool}-install` as FixId, labelKey: 'settings.optional.install' } },
      account: null,
    };
  }
  const install: OptionalRowModel = tool === 'codex' && info.outdated
    ? { tone: 'muted', statusKey: 'settings.optional.outdated', action: { fix: 'codex-update', labelKey: 'settings.optional.update' } }
    : { tone: 'ok', statusKey: 'settings.optional.installed', action: null };
  const account: OptionalRowModel = info.signedIn
    ? { tone: 'ok', statusKey: 'settings.optional.signedIn', action: null }
    : { tone: 'muted', statusKey: 'settings.optional.signedOut', action: { fix: `${tool}-signin` as FixId, labelKey: 'settings.optional.signIn' } };
  return { ...base, install, account };
}

/** The account line: who, which plan, and how much of its windows is used. Antigravity's quota
 *  cannot be read here, and the line says so rather than drawing an empty bar. */
export function accountSummary(tool: OptionalTool, acc: ToolAccountWire | undefined, t: (key: string) => string): string {
  const parts: string[] = [];
  if (acc?.email) parts.push(acc.email);
  if (acc?.planType) parts.push(acc.planType);
  if (tool === 'antigravity') {
    parts.push(t('settings.optional.quotaUnread'));
  } else {
    for (const w of (acc?.windows ?? []).slice(0, 2)) parts.push(`${w.label} %${Math.round(w.usedPercent)}`);
  }
  return parts.join(' · ');
}

/** The account a summary speaks for: the one the tool uses first. */
export function primaryAccount(accounts: readonly ToolAccountWire[] | undefined): ToolAccountWire | undefined {
  return accounts?.find((a) => a.isPrimary) ?? accounts?.[0];
}
