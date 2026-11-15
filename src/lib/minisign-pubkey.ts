import { createHash, createPublicKey, verify } from 'node:crypto';

/**
 * The ONE key every installed app build is checked against before it is run or placed (plan
 * npmsiz-beta C10): the in-app updater's minisign pubkey, the same base64 text as
 * `desktop/src-tauri/tauri.conf.json` `plugins.updater.pubkey`. A drift test
 * (tests/unit/minisign-pubkey.test.ts) holds the two together, so a key rotation that forgets
 * one side fails CI instead of leaving the CLI trusting a key the app no longer uses.
 *
 * The release job signs `<asset>.sig` beside every update payload (the Mac `.app.tar.gz`, the
 * Windows setup `.exe`); the CLI's `app update` refuses either without a `.sig` this key made.
 * The `.sha256` beside them is integrity only: it comes from the same release.
 */
export const APP_UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJEN0IxNjJERTc1N0VGQkQKUldTOTcxZm5MUlo3TGNnaHlvRlQ1RDNnNUl0cVR5WVVVTmVodEk1bW1PYW54VlF3YVNLTWd4YkcK';

const b64 = (text: string): Buffer => Buffer.from(text.trim(), 'base64');
const lines = (b64text: string): string[] => b64(b64text).toString('utf-8').split('\n').map((l) => l.replace(/\r$/, ''));
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow. */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** The Ed25519 key and the 8-byte key id in a tauri updater pubkey (base64 of a minisign
 *  public key file). Throws on anything else. */
export function parseMinisignPubkey(pubkeyB64: string): { keyId: Buffer; key: ReturnType<typeof createPublicKey> } {
  const raw = b64(lines(pubkeyB64)[1] ?? '');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign public key');
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]), format: 'der', type: 'spki' }),
  };
}

/**
 * True when `signatureB64` (a tauri `.sig`: base64 of a minisign signature file) signs `data`
 * with `pubkeyB64`: the key id matches (a foreign key is refused before any math), the signature
 * covers the bytes (BLAKE2b-512 prehash for `ED`, the raw bytes for legacy `Ed`), and the global
 * signature covers the trusted comment. Never throws: anything malformed is false.
 * Same algorithm as scripts/release-latest-json.mjs `verifyMinisign` (the release side).
 */
export function verifyMinisign(data: Buffer, signatureB64: string, pubkeyB64: string = APP_UPDATER_PUBKEY): boolean {
  try {
    const { keyId, key } = parseMinisignPubkey(pubkeyB64);
    const [, sigLine, trusted, globalLine] = lines(signatureB64);
    const sig = b64(sigLine ?? '');
    if (sig.length !== 74 || !trusted?.startsWith('trusted comment: ')) return false;
    const alg = sig.subarray(0, 2).toString('latin1');
    if (!sig.subarray(2, 10).equals(keyId) || (alg !== 'ED' && alg !== 'Ed')) return false;
    const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
    if (!verify(null, signed, key, sig.subarray(10))) return false;
    const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf-8');
    return verify(null, Buffer.concat([sig.subarray(10), comment]), key, b64(globalLine ?? ''));
  } catch {
    return false;
  }
}
