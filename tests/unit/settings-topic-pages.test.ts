/**
 * Settings window topic pages (task settings-konuya-gore-17-menuye…, wave 4): Voice in 8 rows
 * with an explicit Install and a two-step key removal, the Assistant's profile and how it
 * works, Task mirroring as one choice, Team sync owning the GitHub account, MCP with a
 * read-only Codex column, Memory search with its measurements.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', rel), 'utf-8');
const voice = read('components/settings/window/VoiceRows.tsx');
const dictation = read('components/settings/DictationInstall.tsx');
const assistant = read('components/settings/window/pages/AssistantPage.tsx');
const mirror = read('components/settings/window/TaskMirroring.tsx');
const cloud = read('components/settings/CloudTaskSync.tsx');
const topics = read('components/settings/window/pages/TopicPages.tsx');
const mcp = read('components/settings/McpServers.tsx');
const settingsPage = read('pages/SettingsPage.tsx');
const client = read('lib/assistantProfile.ts');

describe('Voice', () => {
  it('eight rows in three cards, in the prototype order', () => {
    const ids = [...voice.matchAll(/\bid="([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['engine', 'whisper', 'ptt', 'langs', 'speakchat', 'voicetone', 'orkey']);
    // Seven ids: the Whisper row is drawn only for "On this Mac", the eighth is the key's row.
    expect(voice.match(/<SettingGroup title=/g)?.length).toBe(3);
  });

  it('shares the dictation state with the classic row, no DOM change there', () => {
    expect(dictation).toMatch(/export function useDictationState\(\)/);
    expect(dictation).toMatch(/export function DictationInstall\(\) \{\n  const \{ state, failed, read, choose, sending, postError, setPostError, picking, setPicking, pick, setPick, busy \} = useDictationState\(\);/);
    expect(voice).toMatch(/const dict = useDictationState\(\);/);
  });

  it('On this Mac never downloads on its own: only the Install button chooses a model', () => {
    const onLocal = voice.slice(voice.indexOf("if (v === 'cloud')"), voice.indexOf("else setWantLocal(true);") + 30);
    expect(onLocal).toContain('setWantLocal(true)');
    expect(onLocal).not.toMatch(/choose\(shownModel\)|choose\('local'/);
    expect(voice.match(/dict\.choose\(/g)?.length).toBe(2); // cloud, and the Install button
    expect(voice).toMatch(/data-testid="sw-whisper-install"[\s\S]{0,80}onClick=\{\(\) => \{ void dict\.choose\(shownModel\)/);
  });

  it('removing the key takes two steps and says what stops; local dictation stays', () => {
    expect(voice).toMatch(/data-testid="sw-key-remove" onClick=\{\(\) => setKeyMode\('ask'\)\}/);
    expect(voice).toMatch(/data-testid="sw-key-remove-go"[^>]*onClick=\{\(\) => \{ void save\(\{ openRouterKey: null \}\)/);
    expect(voice).toMatch(/t\(cloud \? 'shell\.sw\.voice\.key\.ask\.cloud' : 'shell\.sw\.voice\.key\.ask\.local'\)/);
    expect(voice).not.toMatch(/window\.confirm|\bconfirm\(/);
  });

  it('read aloud goes passive without a key, and turning it on writes both switches', () => {
    expect(voice).toMatch(/checked=\{speaking && status\.key\}/);
    expect(voice).toMatch(/disabled=\{saving \|\| !status\.key\}/);
    expect(voice).toMatch(/toggleReadAloud\(v\);\s*if \(v && !status\.speech\) void save\(\{ speech: true \}\);/);
  });
});

describe('Assistant', () => {
  it('a failed read is an error with a retry, never "no assistant" (setup would overwrite it)', () => {
    expect(assistant).toMatch(/if \(st\.exists === false\) \{ setData\('none'\); return; \}/);
    expect(assistant).toMatch(/\} catch \{\s*setData\('error'\);/);
    expect(assistant).toMatch(/data-testid="sw-assistant-retry"/);
    const chip = read('components/settings/window/JobChip.tsx');
    expect(chip).not.toMatch(/\(\) => 'none' as const/);
  });

  it('every save lands on the current data, never on the render\'s snapshot', () => {
    expect(assistant).not.toMatch(/onSaved\(\{ \.\.\.data/);
    expect(assistant.match(/onSaved\(\(d\) => \(\{ \.\.\.d, /g)?.length).toBe(5);
  });

  it('picture upload and remove, name, character, three autonomies, wake key, start at login', () => {
    expect(assistant).toMatch(/uploadAvatar\(f\)/);
    expect(assistant).toMatch(/await removeAvatar\(\)/);
    expect(client).toMatch(/request<\{ ok: boolean \}>\('\/api\/assistant\/avatar', \{ method: 'DELETE' \}\)/);
    expect(assistant).toMatch(/saveProfile\(\{ name: v \}\)/);
    expect(assistant).toMatch(/const sent = charDraft; await saveProfile\(\{ character: sent \}\)/);
    expect(assistant).toMatch(/const AUTONOMIES: readonly AssistantAutonomy\[\] = \['ask', 'auto', 'bypass'\];/);
    expect(assistant).toMatch(/persist\(\{ autonomy: a \}\)/);
    expect(assistant).toMatch(/persist\(\{ hotkey: next \}\); setHk\(await applyAssistantHotkey\(\)\)/);
    expect(assistant).toMatch(/setAssistantAutostart\(v\)[\s\S]{0,300}persist\(\{ autostart: r\.enabled \}\)/);
    expect(assistant).toMatch(/maxLength=\{CHARACTER_MAX\}/);
  });

  it('with no assistant: one button opens the setup, the window keeps Esc away from it', () => {
    expect(assistant).toMatch(/data-testid="sw-assistant-setup" onClick=\{\(\) => setWizard\(true\)\}/);
    expect(assistant).toMatch(/<div data-sw-modal>\s*<AssistantWizard exists=\{false\}/);
  });

  it('read aloud needs the voice key, and the model row is the shared chip', () => {
    expect(assistant).toMatch(/why=\{!voiceKey \? t\('shell\.sw\.voice\.needsKey'\) : undefined\}/);
    expect(assistant).toMatch(/control=\{chip\?\.\('assistant'\)\}/);
  });
});

describe('Task mirroring and Team sync', () => {
  it('one choice writes taskBackend: Off, GitHub Issues, ClickUp', () => {
    expect(mirror).toMatch(/update\.mutateAsync\(\{ taskBackend: next \}\)/);
    expect(mirror).toMatch(/\{ value: 'local', label: t\('shell\.sw\.mirror\.off'\) \}/);
    expect(mirror).toMatch(/\{ value: 'github', label: 'GitHub Issues' \}/);
    expect(mirror).toMatch(/\{ value: 'clickup', label: 'ClickUp' \}/);
  });

  it('GitHub with no login still opens (a PAT or env token wins), with a reason and a Team sync link', () => {
    expect(mirror).not.toMatch(/v === 'github' && noLogin/);
    expect(mirror).toMatch(/onChange=\{choose\}/);
    expect(mirror).toMatch(/why=\{backend !== 'github' && noLogin \? t\('shell\.sw\.mirror\.noLogin'\) : undefined\}/);
    expect(mirror).toMatch(/go\?\.\('teamsync'\)/);
  });

  it('embedded: no switch, no "other active" row, no token row while the login supplies it', () => {
    expect(mirror.match(/<CloudTaskSync provider="(github|clickup)" embedded \/>/g)?.length).toBe(2);
    expect(cloud).toMatch(/\{!embedded && <SettingRow\s+title=\{toggleLabel\}/);
    expect(cloud).toMatch(/\{otherActive && !embedded && \(/);
    expect(cloud).toMatch(/const loginSuppliesToken = embedded && provider === 'github' && !!auth\?\.connected\s*&& \(!providerTokenStatus\?\.set \|\| providerTokenStatus\.source === 'global'\);/);
    expect(cloud).toMatch(/\{!loginSuppliesToken && <SettingRow\s+title=\{t\('settings\.cloud_tasks\.api_key'\)\}/);
  });

  it('Team sync rows are one component in both Settings, the GitHub account sits on Team sync', () => {
    expect(settingsPage).toMatch(/<TeamSyncRows \/>/);
    expect(topics).toMatch(/<TeamSyncRows title=\{t\('shell\.sw\.teamsync\.sync'\)\} \/>/);
    expect(topics).toMatch(/<GitHubLogin \/>/);
  });
});

describe('MCP', () => {
  it('the window asks for the Codex column; classic does not', () => {
    expect(topics).toMatch(/<McpServers codex \/>/);
    expect(settingsPage).not.toMatch(/<McpServers codex/);
    expect(mcp).toMatch(/export function McpServers\(\{ codex = false \}/);
  });

  it('the Codex column reads the whitelisted list and offers no Codex sign-in or Add', () => {
    expect(mcp).toMatch(/api\.get<CodexMcpList>\('\/agent\/mcp\/codex'\)/);
    expect(mcp).toMatch(/if \(r\.home === 'claudeai'\) return <span className="mcpm-absent" title="claude\.ai connectors exist only in Claude Code\.">/);
    const codexOnly = mcp.slice(mcp.indexOf('{codexOnly.length > 0 && ('), mcp.indexOf('</tbody>'));
    expect(codexOnly).not.toMatch(/connect\(|setForm\(|<button/);
    expect(codexOnly).toMatch(/<td className="mcpm-actions" \/>/);
  });
});

describe('Memory search', () => {
  it('shows the measured ways to search (with the cloud setup) and the native memory row', () => {
    expect(topics).toMatch(/<RecallModeCards/);
    expect(read('components/settings/RecallModeCards.tsx')).toMatch(/<CloudRecallCard/);
    expect(topics).toMatch(/disableNativeMemory: !disabled/);
  });
});
