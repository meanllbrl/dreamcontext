/**
 * app-ux-genel W2 (K4, K5, S2): the chat's app approval card speaks the UI's language, keeps the
 * technical lines under Details and follows the real run; the Shared Apps list shows a readable
 * name, ONE Kur, and puts an unknown inviter apart. Rendered with the real components and the real
 * English and Turkish tables. Fictional apps and people (synthetic-fixtures pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { STATE } = vi.hoisted(() => ({ STATE: { lang: 'en' as 'en' | 'tr', data: null as unknown } }));

/** The real tables, read from the source: every key the cards use must exist in both. */
const SRC = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'context', 'I18nContext.tsx'), 'utf-8');
function lookup(lang: 'en' | 'tr', key: string): string {
  const all = [...SRC.matchAll(new RegExp(`^\\s*"${key.replace(/\./g, '\\.')}": "(.*)",$`, 'gm'))].map((m) => JSON.parse(`"${m[1]}"`) as string);
  return (lang === 'en' ? all[0] : all[1] ?? all[0]) ?? key;
}

vi.mock('../../dashboard/src/context/I18nContext.js', () => {
  const t = (key: string) => lookup(STATE.lang, key);
  return { useI18n: () => ({ locale: STATE.lang, setLocale: () => {}, t }), useOwnerCardT: () => t };
});
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({ get: async () => ({}), post: async () => ({}), ownerPost: async () => ({}) }) }));
vi.mock('../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js', async (orig) => ({
  ...(await orig<object>()),
  useQuery: () => ({ data: STATE.data, isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock('../../dashboard/src/lib/phoneSurface.js', () => ({ phoneAllows: () => true }));

const { AppRequestCard } = await import('../../dashboard/src/components/sleepy/chat/AppRequestCard.js');
const { SharedApps } = await import('../../dashboard/src/components/apps/SharedApps.js');

const card = (state: string, extra: Record<string, unknown> = {}) => ({
  state,
  ...extra,
  card: {
    action: 'install', appName: 'Hava Notu', vault: 'acme', title: 'Daveti kabul et ve kur', hash: 'h',
    warn: 'Bu davet tanımadığın bir GitHub hesabından geliyor.',
    lines: [
      { key: 'invitedByUnknown', label: 'Davet eden', value: 'yabanci-hesap (tanımadığın bir GitHub hesabı)', tone: 'warn' },
      { key: 'where', label: 'Nerede çalışır', value: "Senin Mac'inde, senin izinlerinle", valueKey: 'where.mac' },
      { key: 'licence', label: 'Lisans', value: 'Kullanabilirsin, başkasıyla paylaşamazsın', valueKey: 'licence.restricted' },
      { key: 'repo', label: 'Repo', value: 'ornek/hava-notu-app', detail: true },
    ],
  },
});
const draw = () => renderToStaticMarkup(createElement(AppRequestCard, { spec: { type: 'app-request', id: '0b1d3c97-6daf-4943-96d5-8614e7d0960e' } as never }));

describe('the app approval card (K4, K5)', () => {
  beforeEach(() => { STATE.lang = 'en'; });

  it('speaks English in the English UI: title, labels, licence in words, no raw server words', () => {
    STATE.data = card('pending');
    const html = draw();
    expect(html).toContain('Accept the invitation and install · Hava Notu');
    expect(html).toContain('On your Mac, with your permissions');
    expect(html).toContain('You may use it, not share it on');
    expect(html).toContain("yabanci-hesap (a GitHub account you don&#x27;t know)");
    expect(html).toContain('This invitation comes from a GitHub account you don&#x27;t know.');
    expect(html).not.toMatch(/Repo türü|restricted|Lisans|Nerede/);
    // The plain fact is not painted as a warning; the unknown inviter is.
    expect(html).toMatch(/data-tone="warn"><dt>Invited by/);
    expect(html).not.toMatch(/data-tone="(warn|bad)"><dt>Runs/);
    // The repository sits under Details only.
    const [beforeDetails, details] = html.split('<details');
    expect(beforeDetails).not.toContain('ornek/hava-notu-app');
    expect(details).toContain('ornek/hava-notu-app');
    expect(html).toContain('>Approve<');
  });

  it('follows the run in Turkish: handed over, installing, installed, or failed with its reason', () => {
    STATE.lang = 'tr';
    const line = (state: string, extra: Record<string, unknown> = {}) => { STATE.data = card(state, extra); return draw(); };
    expect(line('approved')).toContain("Onaylandı, Claude&#x27;a iletiliyor.");
    expect(line('running')).toContain('Kuruluyor…');
    expect(line('used')).toContain('Kuruldu.');
    // Review r1: an invitation accepted, its install held back: never "Kuruldu".
    const held = line('used', { stopped: 'MCP sunucuları: posthog' });
    expect(held).toContain('Davet kabul edildi ama bir şey kurulmadı: MCP sunucuları: posthog.');
    expect(held).not.toContain('Kuruldu.');
    expect(line('failed', { failed: 'paket kurulamadı' })).toContain('Olmadı: paket kurulamadı');
    expect(line('running')).not.toContain('Onayla<');
  });
});

describe('Shared Apps (K1, K2, S2)', () => {
  beforeEach(() => { STATE.lang = 'tr'; });
  const list = {
    signedIn: true, login: 'ben', host: 'github',
    invitations: [
      { id: '1', fullName: 'ali-kaya/toplanti-notu-app', repoId: '11', inviter: 'ali-kaya', known: true, title: 'Toplanti notu' },
      { id: '2', fullName: 'yabanci/hava-app', repoId: '22', inviter: 'yabanci', known: false, title: 'Hava' },
    ],
    shared: [],
  };
  const drawList = (installing = false) => renderToStaticMarkup(createElement(SharedApps, {
    list, err: null, loading: false, installedLook: () => null, installing: () => installing,
    onRefresh: () => {}, onInstall: () => {}, onOpen: () => {}, onAccepted: () => {}, onSignIn: () => {},
  }));

  it('a known invitation: its readable name, who shared it, one Kur; an unknown one apart and said', () => {
    const html = drawList();
    expect(html).toContain('Toplanti notu');
    expect(html).toContain('ali-kaya seni davet etti');
    expect(html).not.toContain('Kabul et');
    expect(html.match(/>Kur</g)?.length).toBe(2);
    const [knownPart, unknownPart] = html.split('Tanımadığın GitHub hesaplarından');
    expect(knownPart).toContain('Toplanti notu');
    expect(knownPart).not.toContain('yabanci');
    expect(unknownPart).toContain('yabanci: tanımadığın bir GitHub hesabı');
  });

  it('while the install runs the row says so', () => {
    expect(drawList(true)).toContain('Kuruluyor…');
  });
});
