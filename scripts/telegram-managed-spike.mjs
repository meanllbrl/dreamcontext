#!/usr/bin/env node
/**
 * MANUAL spike for Telegram managed bots (plan X1, Z4, Z6). Real bot, real account; never in CI.
 *
 * The owner makes a test MANAGER bot in BotFather with Bot Management Mode on and puts its token
 * in an env file (the app's secret card writes it; this script never prints it). Then:
 *
 *   node scripts/telegram-managed-spike.mjs --env <path to .env file>          the main run
 *   node scripts/telegram-managed-spike.mjs --env <file> --check-access        re-test (d)/(e) later
 *
 * Settles:
 *   (a) the getManagedBotToken parameter name (`user_id` vs `bot_user_id`) and whether getMe shows
 *       the management flag;
 *   (b) whether a freshly created managed bot can message its creator with no /start;
 *   (c) what arrives when the account's bot limit is reached (expected: nothing, so a timeout);
 *   (d) whether management survives revoking the MANAGER's token (re-run with --check-access
 *       after /revoke + putting the new token in the env file);
 *   (e) whether turning Bot Management Mode off ends getManagedBotToken (re-run --check-access).
 *
 * Writes `tmp/telegram-spike-result.json` next to the env file's folder? No: next to THIS repo's
 * tmp/ (git-ignored), with ids and verdicts only. No token is ever printed, logged or written.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'tmp', 'telegram-spike.json');
const RESULT = join(ROOT, 'tmp', 'telegram-spike-result.json');
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const WAIT_MS = 10 * 60 * 1000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function redact(text, ...tokens) {
  let out = String(text);
  for (const t of tokens) if (t) out = out.split(t).join('<token>');
  return out.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, '<token>');
}

function loadToken() {
  const fromEnv = process.env.TELEGRAM_SPIKE_TOKEN;
  if (fromEnv) return fromEnv.trim();
  const file = opt('--env');
  if (!file) return null;
  const raw = readFileSync(resolve(file), 'utf-8');
  const m = /^\s*TELEGRAM_SPIKE_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(raw);
  return m ? m[1].trim() : null;
}

const token = loadToken();
if (!token || !TOKEN_RE.test(token)) {
  console.error('TELEGRAM_SPIKE_TOKEN bulunamadı ya da biçimi yanlış (--env <dosya> ver).');
  process.exit(2);
}

async function api(tok, method, params = {}) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${tok}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
    });
  } catch (err) {
    return { ok: false, error_code: 0, description: redact(err?.message ?? 'network error', token, tok) };
  }
  const body = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
  if (body && typeof body.description === 'string') body.description = redact(body.description, token, tok);
  return body;
}

/** Keys and ids of an object, never values that could be a token. */
function shape(v, depth = 0) {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? (TOKEN_RE.test(v) ? '<token>' : v.slice(0, 40)) : v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => shape(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
}

const result = existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, 'utf-8')) : {};
const save = () => { mkdirSync(dirname(RESULT), { recursive: true }); writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`); };
const log = (line) => console.log(line);

async function tryToken(botId) {
  for (const param of ['user_id', 'bot_user_id']) {
    const r = await api(token, 'getManagedBotToken', { [param]: botId });
    const t = typeof r.result === 'string' ? r.result : r.result?.token;
    if (r.ok && typeof t === 'string' && TOKEN_RE.test(t)) return { param, token: t, error: null };
    log(`  getManagedBotToken(${param}) → ${r.error_code ?? '?'} ${r.description ?? ''}`);
  }
  return { param: null, token: null, error: 'neither parameter worked' };
}

async function main() {
  const me = await api(token, 'getMe');
  if (!me.ok) { log(`getMe başarısız: ${me.description}`); process.exit(1); }
  const flags = Object.fromEntries(Object.entries(me.result).filter(([, v]) => typeof v === 'boolean'));
  log(`Yönetici bot: @${me.result.username} (id ${me.result.id})`);
  log(`getMe bayrakları: ${JSON.stringify(flags)}`);
  result.a_getMeFlags = flags;
  result.a_managementFlag = Object.keys(flags).find((k) => /manag/i.test(k)) ?? null;

  if (flag('--check-access')) {
    const st = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf-8')) : null;
    if (!st?.botId) { log('Önce ana çalıştırma gerekli (kayıtlı bot yok).'); process.exit(2); }
    const r = await tryToken(st.botId);
    const verdict = r.token ? 'erişim VAR' : 'erişim YOK';
    log(`(d)/(e) kontrol: @${st.botUsername} için getManagedBotToken → ${verdict}`);
    (result.checks ??= []).push({ at: new Date().toISOString(), managerBotId: me.result.id, access: !!r.token, note: opt('--note') ?? null });
    save();
    return;
  }

  const hook = await api(token, 'getWebhookInfo');
  if (hook.ok && hook.result?.url) { log('Bu botta webhook kurulu; spike için kaldırılması gerekir (deleteWebhook).'); process.exit(1); }

  // Skip whatever is queued, so only the creation we ask for counts.
  let offset = 0;
  const backlog = await api(token, 'getUpdates', { timeout: 0, allowed_updates: ['managed_bot', 'message'] });
  if (backlog.ok && backlog.result.length) offset = backlog.result[backlog.result.length - 1].update_id + 1;

  const suggested = `dcspike_${randomBytes(2).toString('hex')}_bot`;
  const link = `https://t.me/newbot/${me.result.username}/${suggested}?name=${encodeURIComponent('dreamcontext spike').replace(/%20/g, '+')}`;
  log('');
  log('1) Telefonda bu bağlantıyı aç ve Telegram\'ın açtığı pencerede botu oluştur:');
  log(`   ${link}`);
  log('2) Oluşturduktan sonra yeni bota HİÇBİR ŞEY yazma, /start\'a basma. Bekliyorum (en fazla 10 dk)…');

  const deadline = Date.now() + WAIT_MS;
  let created = null;
  while (Date.now() < deadline && !created) {
    const r = await api(token, 'getUpdates', { offset, timeout: 30, allowed_updates: ['managed_bot', 'message'] });
    if (!r.ok) { log(`getUpdates: ${r.error_code} ${r.description}`); await new Promise((s) => setTimeout(s, 3000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      if (u.managed_bot) {
        log(`managed_bot geldi, yapısı: ${JSON.stringify(shape(u.managed_bot))}`);
        result.wireShape = shape(u.managed_bot);
        created = u.managed_bot;
      } else if (u.message) {
        log(`(yöneticiye gelen mesaj, yok sayıldı: from ${u.message.from?.id})`);
      }
    }
  }
  if (!created) {
    log('10 dakikada managed_bot gelmedi. Bot sınırı doluysa beklenen budur (c): hiçbir şey gelmez.');
    result.c_noUpdateWithin10Min = true;
    save();
    process.exit(1);
  }

  const bot = created.bot ?? created.managed_bot;
  const creator = created.user ?? created.creator ?? created.from;
  log(`Yeni bot: @${bot?.username} (id ${bot?.id}); oluşturan: id ${creator?.id}`);
  const got = await tryToken(bot.id);
  result.a_tokenParam = got.param;
  result.botCreated = { botId: bot.id, botUsername: bot.username ?? null, creatorId: creator?.id ?? null, managerBotId: me.result.id };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify({ botId: bot.id, botUsername: bot.username ?? null }, null, 2)}\n`);
  if (!got.token) {
    log('Token alınamadı: X v1 için düşer (Z6 kuralı), kendi token akışı varsayılan kalır.');
    result.verdict = 'X_DROPPED_no_token';
    save();
    process.exit(1);
  }
  log(`(a) getManagedBotToken parametresi: ${got.param} (token alındı, yazdırılmadı)`);
  const newMe = await api(got.token, 'getMe');
  result.tokenWorks = !!newMe.ok && newMe.result?.id === bot.id;
  log(`Yeni botun tokenı çalışıyor mu: ${result.tokenWorks ? 'evet' : 'hayır'}`);

  const first = await api(got.token, 'sendMessage', { chat_id: creator.id, text: 'Ben dreamcontext spike botu. /start olmadan yazabiliyor muyum?' });
  result.b_canWriteFirst = !!first.ok;
  result.b_error = first.ok ? null : `${first.error_code} ${first.description}`;
  log(`(b) /start olmadan ilk mesaj: ${first.ok ? 'GİTTİ' : `gitmedi (${result.b_error})`}`);

  result.verdict = result.tokenWorks ? 'X_WORKS' : 'X_DROPPED_token_unusable';
  save();
  log('');
  log(`Sonuç: ${result.verdict}. Ayrıntı: ${RESULT}`);
  log('(d) için: BotFather\'da yönetici botta /revoke yap, yeni tokenı aynı dosyaya koy, --check-access ile tekrar çalıştır.');
  log('(e) için: Bot Management Mode\'u kapat, --check-access ile tekrar çalıştır.');
}

main().catch((err) => { console.error(redact(err?.stack ?? String(err), token)); process.exit(1); });
