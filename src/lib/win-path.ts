import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The ONE writer of `HKCU\Environment` (plan npmsiz-beta C5′). It may make exactly these writes,
 * and no other:
 *   - add `%USERPROFILE%\.dreamcontext\bin\cli` to `Path` (skipped while the owner's opt-out
 *     record `~/.dreamcontext/cli-path-optout.json` exists);
 *   - add PortableGit's `cmd\` (`%USERPROFILE%\.dreamcontext\bin\tools\git\cmd`) to `Path`;
 *   - add `%USERPROFILE%\.local\bin` to `Path`, only when Anthropic's installer left `claude.exe`
 *     there off PATH;
 *   - set `CLAUDE_CODE_GIT_BASH_PATH`, only when the Windows spike shows Claude Code needs it.
 *
 * `Path` keeps its `REG_EXPAND_SZ` type and every other entry byte for byte. Presence is an exact
 * entry match (case-insensitive, as Windows compares paths); a second run adds nothing; removal
 * takes out exactly ours and keeps every entry another program added, before or after us.
 * Registry access goes through `reg.exe` with an argv array, never a shell.
 */

export type RegType = 'REG_SZ' | 'REG_EXPAND_SZ';
export interface RegValue { type: RegType; value: string }

/**
 * The only registry surface the writer uses, so a test can hand it a fake. `read` returns null
 * ONLY for a value that is confirmed absent; any failure to read throws, so nothing is written
 * from a guess (a blank `Path` would otherwise replace the user's whole one).
 */
export interface EnvRegistry {
  read(name: string): RegValue | null;
  write(name: string, v: RegValue): void;
  remove(name: string): void;
}

/** The `Path` entries this writer may add, as they are stored (unexpanded). */
export const PATH_ENTRIES = {
  cli: '%USERPROFILE%\\.dreamcontext\\bin\\cli',
  gitCmd: '%USERPROFILE%\\.dreamcontext\\bin\\tools\\git\\cmd',
  claudeLocal: '%USERPROFILE%\\.local\\bin',
} as const;
export type PathEntryId = keyof typeof PATH_ENTRIES;

export const GIT_BASH_VAR = 'CLAUDE_CODE_GIT_BASH_PATH';
/** The only value {@link GIT_BASH_VAR} may hold: the app's PortableGit bash. */
export const GIT_BASH_VALUE = '%USERPROFILE%\\.dreamcontext\\bin\\tools\\git\\bin\\bash.exe';

const sameEntry = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** An entry as stored for `REG_EXPAND_SZ` (unexpanded), then expanded against this profile folder. */
function entryForms(id: PathEntryId, home: string): [string, string] {
  const raw = PATH_ENTRIES[id];
  return [raw, raw.replace(/^%USERPROFILE%/i, home.replace(/\//g, '\\'))];
}

/** `Path` with `entry` appended when no entry equals it; null when it is already there. */
export function pathWithEntry(current: string | null, entry: string): string | null {
  const cur = current ?? '';
  if (cur.split(';').some((e) => sameEntry(e, entry))) return null;
  if (cur === '') return entry;
  return cur.endsWith(';') ? `${cur}${entry}` : `${cur};${entry}`;
}

/** `Path` without exactly `entry` (every other entry and separator byte for byte); null when absent. */
export function pathWithoutEntry(current: string | null, entry: string): string | null {
  if (current === null) return null;
  const parts = current.split(';');
  const kept = parts.filter((e) => !sameEntry(e, entry));
  if (kept.length === parts.length) return null;
  return kept.join(';');
}

export function cliPathOptOutPath(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'cli-path-optout.json');
}

/** The owner's "Remove from terminal" record: a plain file means the `bin\cli` entry stays out. */
export function cliPathOptedOut(home: string = homedir()): boolean {
  try { return lstatSync(cliPathOptOutPath(home)).isFile(); } catch { return false; }
}

export interface EnsureWants {
  cli?: boolean;
  gitCmd?: boolean;
  claudeLocal?: boolean;
  gitBashPath?: boolean;
}

export interface EnvWrite { name: string; action: 'add-path' | 'remove-path' | 'set'; entry: string }

/**
 * Add what `wants` names and is missing. Returns the writes made (empty on a second run). A
 * missing `Path` is created as `REG_EXPAND_SZ`; an existing one keeps its type.
 */
export function ensureWinEnv(reg: EnvRegistry, wants: EnsureWants, home: string = homedir()): EnvWrite[] {
  const writes: EnvWrite[] = [];
  const ids: PathEntryId[] = [];
  if (wants.cli && !cliPathOptedOut(home)) ids.push('cli');
  if (wants.gitCmd) ids.push('gitCmd');
  if (wants.claudeLocal) ids.push('claudeLocal');
  let path = reg.read('Path');
  for (const id of ids) {
    // A REG_SZ Path is never expanded by Windows, so there the entry goes in already expanded.
    const forms = entryForms(id, home);
    if (path && path.value.split(';').some((e) => forms.some((f) => sameEntry(e, f)))) continue;
    const entry = path?.type === 'REG_SZ' ? forms[1] : forms[0];
    const next = pathWithEntry(path?.value ?? null, entry);
    if (next === null) continue;
    path = { type: path?.type ?? 'REG_EXPAND_SZ', value: next };
    reg.write('Path', path);
    writes.push({ name: 'Path', action: 'add-path', entry });
  }
  if (wants.gitBashPath) {
    const cur = reg.read(GIT_BASH_VAR);
    // Someone else's value is never overwritten; ours is never written twice.
    if (!cur) {
      reg.write(GIT_BASH_VAR, { type: 'REG_EXPAND_SZ', value: GIT_BASH_VALUE });
      writes.push({ name: GIT_BASH_VAR, action: 'set', entry: GIT_BASH_VALUE });
    }
  }
  return writes;
}

/** Remove exactly our entries (uninstall, or "Remove from terminal" for `cli`). */
export function removeWinEnv(reg: EnvRegistry, ids: readonly PathEntryId[], opts: { gitBashPath?: boolean; home?: string } = {}): EnvWrite[] {
  const writes: EnvWrite[] = [];
  let path = reg.read('Path');
  for (const id of ids) {
    // Only the form this writer would have written for this Path's type: an expanded entry in a
    // REG_EXPAND_SZ Path was put there by someone else (Claude's own installer, say).
    const forms = entryForms(id, opts.home ?? homedir());
    for (const entry of [path?.type === 'REG_SZ' ? forms[1] : forms[0]]) {
      const next = pathWithoutEntry(path?.value ?? null, entry);
      if (next === null || !path) continue;
      path = { type: path.type, value: next };
      reg.write('Path', path);
      writes.push({ name: 'Path', action: 'remove-path', entry });
    }
  }
  if (opts.gitBashPath) {
    const cur = reg.read(GIT_BASH_VAR);
    if (cur && sameEntry(cur.value, GIT_BASH_VALUE)) {
      reg.remove(GIT_BASH_VAR);
      writes.push({ name: GIT_BASH_VAR, action: 'remove-path', entry: GIT_BASH_VALUE });
    }
  }
  return writes;
}

// ─── The real registry, exact UTF-16 through a fixed PowerShell script ─────────────
//
// `reg.exe query` prints in the OEM code page, so a non-ASCII entry (C:\Users\Gökhan\…) would
// come back damaged and be written back damaged. These scripts read and write the value as .NET
// strings (UTF-16, `DoNotExpandEnvironmentNames`), and every byte of data crosses as base64 in an
// environment variable: nothing is interpolated into the script, no shell parses it.

/** The only names this writer touches. */
const NAMES = new Set(['path', GIT_BASH_VAR.toLowerCase()]);

const PS_READ = [
  "$ErrorActionPreference='Stop'",
  "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$false)",
  "if($null -eq $k){'{\"missing\":true}';exit 0}",
  "$n=$env:DC_REG_NAME",
  "if($k.GetValueNames() -notcontains $n){'{\"missing\":true}';exit 0}",
  "$kind=$k.GetValueKind($n).ToString()",
  "$v=[string]$k.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "'{\"kind\":\"'+$kind+'\",\"b64\":\"'+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))+'\"}'",
].join(';');

const PS_WRITE = [
  "$ErrorActionPreference='Stop'",
  "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$v=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:DC_REG_B64))",
  "$kind=if($env:DC_REG_KIND -eq 'REG_EXPAND_SZ'){[Microsoft.Win32.RegistryValueKind]::ExpandString}else{[Microsoft.Win32.RegistryValueKind]::String}",
  "$k.SetValue($env:DC_REG_NAME,$v,$kind)",
].join(';');

const PS_REMOVE = [
  "$ErrorActionPreference='Stop'",
  "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
  "if($null -ne $k){$k.DeleteValue($env:DC_REG_NAME,$false)}",
].join(';');

/**
 * Parse {@link PS_READ}'s one line: `{"missing":true}` is a confirmed absence; a kind and base64
 * data is the exact value. Anything else, or a kind other than String / ExpandString, throws.
 */
export function parseRegRead(out: string): RegValue | null {
  const o = JSON.parse(out.trim()) as { missing?: boolean; kind?: string; b64?: string };
  if (o.missing === true) return null;
  if (typeof o.b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(o.b64)) throw new Error('The registry answer could not be read.');
  const type: RegType | null = o.kind === 'ExpandString' ? 'REG_EXPAND_SZ' : o.kind === 'String' ? 'REG_SZ' : null;
  if (!type) throw new Error(`The registry value has a type this writer does not change (${String(o.kind)}).`);
  return { type, value: Buffer.from(o.b64, 'base64').toString('utf16le') };
}

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function realEnvRegistry(): EnvRegistry {
  const run = (script: string, env: Record<string, string>) => execFileSync(
    powershell(), ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, env: { ...process.env, ...env } },
  );
  const checkName = (name: string) => {
    if (!NAMES.has(name.toLowerCase())) throw new Error(`${name} is not a value this writer changes.`);
  };
  return {
    read(name) {
      checkName(name);
      return parseRegRead(run(PS_READ, { DC_REG_NAME: name }));
    },
    write(name, v) {
      checkName(name);
      if (/[\r\n\0]/.test(v.value)) throw new Error('A registry value with a line break is refused.');
      run(PS_WRITE, { DC_REG_NAME: name, DC_REG_KIND: v.type, DC_REG_B64: Buffer.from(v.value, 'utf16le').toString('base64') });
    },
    remove(name) {
      checkName(name);
      run(PS_REMOVE, { DC_REG_NAME: name });
    },
  };
}

/**
 * Tell running programs the environment changed. A fixed PowerShell `SendMessageTimeout` call
 * with no interpolated data; best effort (a new terminal reads the registry anyway).
 */
export const SETTING_CHANGE_SCRIPT = [
  "$sig='[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'",
  "$t=Add-Type -MemberDefinition $sig -Name W -Namespace D -PassThru",
  "$r=[UIntPtr]::Zero",
  "[void]$t::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
].join(';');

export function broadcastEnvChange(): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SETTING_CHANGE_SCRIPT], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  } catch { /* best effort */ }
}
