import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Telegram confirms and the sealed snapshot webview (W3 lane B) are wired end to end:
 * a command `generate_handler!` does not list, a permission no toml declares or a capability
 * that does not grant it is a command the page can never call. And the snapshot window's label
 * must match no capability, or the authored page would get IPC.
 */
const SHELL = join(__dirname, '..', '..', 'desktop', 'src-tauri');
const read = (p: string) => readFileSync(join(SHELL, p), 'utf8');

const COMMANDS: Record<string, { perm: string; toml: string }> = {
  confirm_telegram_binding: { perm: 'allow-confirm-telegram', toml: 'permissions/telegram-confirm.toml' },
  start_telegram_creation: { perm: 'allow-start-telegram-creation', toml: 'permissions/telegram-confirm.toml' },
  start_telegram_readopt: { perm: 'allow-start-telegram-readopt', toml: 'permissions/telegram-confirm.toml' },
  confirm_telegram_forward: { perm: 'allow-confirm-telegram-forward', toml: 'permissions/telegram-forward.toml' },
  html_snapshot: { perm: 'allow-html-snapshot', toml: 'permissions/html-snapshot.toml' },
};

describe('Telegram confirm commands and html_snapshot are registered, permitted and granted', () => {
  const lib = read('src/lib.rs');
  const handlers = lib.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  const cap = JSON.parse(read('capabilities/default.json')) as { windows: string[]; permissions: unknown[] };

  for (const [cmd, { perm, toml }] of Object.entries(COMMANDS)) {
    it(`${cmd}: handler, permission, capability`, () => {
      expect(handlers).toMatch(new RegExp(`::${cmd},`));
      const text = read(toml);
      const block = text.split('[[permission]]').find((b) => b.includes(`identifier = "${perm}"`));
      expect(block, `${perm} declared in ${toml}`).toBeTruthy();
      expect(block).toContain(`commands.allow = ["${cmd}"]`);
      expect(cap.permissions).toContain(perm);
    });
  }

  it('only project windows hold them: the default capability stays main, vault-*, inbox', () => {
    expect(cap.windows).toEqual(['main', 'vault-*', 'inbox']);
  });

  it('the sealed snapshot window `html-snapshot` matches no capability', () => {
    const label = 'html-snapshot';
    expect(read('src/html_snapshot.rs')).toContain(`pub(crate) const LABEL: &str = "${label}";`);
    for (const file of readdirSync(join(SHELL, 'capabilities'))) {
      const c = JSON.parse(read(`capabilities/${file}`)) as { windows?: string[] };
      for (const pat of c.windows ?? []) {
        const hit = pat.endsWith('*') ? label.startsWith(pat.slice(0, -1)) : pat === label;
        expect(hit, `${file}: ${pat}`).toBe(false);
      }
    }
  });

  it('the owner key goes out only from Rust, never back to the page', () => {
    const src = read('src/telegram_confirm.rs');
    expect(src).toContain('fn owner_key_while_server_lives');
    // Every command returns a JSON object it builds itself; none returns the key.
    expect(src).not.toMatch(/Ok\(key\)|"key":/);
  });
});
