#!/usr/bin/env bash
# One-time setup for the Developer ID release (see .github/workflows/desktop-release.yml).
#
# Prerequisites, both done by the Apple account holder:
#   1. A "Developer ID Application" certificate in the login keychain
#      (Xcode › Settings › Accounts › Manage Certificates › + › Developer ID Application).
#   2. An app-specific password for notarization (appleid.apple.com › App-Specific Passwords),
#      written with the Apple ID to an env file as APPLE_ID=… and APPLE_PASSWORD=….
#
# What it does:
#   - exports ONLY that identity (key + certificate) to a .p12 backup under
#     ~/.dreamcontext/release-signing/ (macOS asks once to allow the key export),
#   - checks the notarization credentials against Apple,
#   - creates the in-app updater's minisign key if there is none (backed up beside it),
#   - stores everything via `gh` in the repo's `release` environment, which only `v*` tags
#     can deploy to, so no branch workflow or fork PR can read a key.
# Re-running reuses the backups and only re-uploads. Values travel through stdin, never argv.
#
# Usage: scripts/release-developer-id-setup.sh <env-file-with-APPLE_ID-and-APPLE_PASSWORD> [TEAM_ID]
set -euo pipefail

ENV_FILE="${1:?usage: $0 <env-file> [TEAM_ID]}"
TEAM="${2:-PP8PX5BB5P}"
DIR="$HOME/.dreamcontext/release-signing"
P12="$DIR/developer-id.p12"
PASSFILE="$DIR/developer-id.p12.password"
UKEY="$DIR/updater.key"
UPASS="$DIR/updater.key.password"
mkdir -p "$DIR"
chmod 700 "$DIR"

# ── The identity ──────────────────────────────────────────────────────────────
SHA1="$(security find-identity -v -p codesigning \
  | sed -nE "s/^ *[0-9]+\) ([0-9A-F]{40}) \"Developer ID Application: .* \($TEAM\)\"$/\1/p" | head -1)"
if [ -z "$SHA1" ]; then
  echo "No valid \"Developer ID Application: … ($TEAM)\" identity in the keychain." >&2
  echo "Create it in Xcode › Settings › Accounts › Manage Certificates › + › Developer ID Application." >&2
  exit 1
fi
echo "Identity: $SHA1 (team $TEAM)"

if [ -f "$P12" ] && [ -f "$PASSFILE" ]; then
  echo "Reusing the existing export in $P12"
else
  /usr/bin/openssl rand -hex 24 | tr -d "\n" > "$PASSFILE"
  chmod 600 "$PASSFILE"
  # `security export` cannot pick one identity; SecItemExport on the matching SecIdentity can.
  SWIFT="$(mktemp -t devid-export).swift"
  trap 'rm -f "$SWIFT"' EXIT
  cat > "$SWIFT" <<'SWIFT'
import Foundation
import Security
import CryptoKit
let want = CommandLine.arguments[1].uppercased(), out = CommandLine.arguments[2]
let pass = try! String(contentsOfFile: CommandLine.arguments[3], encoding: .utf8)
var items: CFTypeRef?
let q: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnRef as String: true]
guard SecItemCopyMatching(q as CFDictionary, &items) == errSecSuccess, let ids = items as? [SecIdentity] else { fputs("no identities\n", stderr); exit(1) }
for id in ids {
  var cert: SecCertificate?
  SecIdentityCopyCertificate(id, &cert)
  guard let c = cert else { continue }
  let sha = Insecure.SHA1.hash(data: SecCertificateCopyData(c) as Data).map { String(format: "%02X", $0) }.joined()
  guard sha == want else { continue }
  var params = SecItemImportExportKeyParameters()
  params.version = UInt32(SEC_KEY_IMPORT_EXPORT_PARAMS_VERSION)
  params.passphrase = Unmanaged.passRetained(pass as CFString)
  var data: CFData?
  let st = SecItemExport(id, .formatPKCS12, [], &params, &data)
  guard st == errSecSuccess, let d = data as Data? else { fputs("export failed: \(st)\n", stderr); exit(1) }
  try! d.write(to: URL(fileURLWithPath: out))
  exit(0)
}
fputs("identity \(want) not found\n", stderr); exit(1)
SWIFT
  swift "$SWIFT" "$SHA1" "$P12" "$PASSFILE"
  chmod 600 "$P12"
  echo "Exported to $P12 — back this folder up (1Password or similar)."
fi

# ── Notarization credentials ──────────────────────────────────────────────────
APPLE_ID="$(sed -n 's/^APPLE_ID=//p' "$ENV_FILE" | tr -d '"'"'"' \r')"
APPLE_PASSWORD="$(sed -n 's/^APPLE_PASSWORD=//p' "$ENV_FILE" | tr -d '"'"'"' \r')"
if [ -z "$APPLE_ID" ] || [ -z "$APPLE_PASSWORD" ]; then
  echo "$ENV_FILE must define APPLE_ID and APPLE_PASSWORD." >&2
  exit 1
fi
if ! xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM" >/dev/null 2>&1; then
  echo "Apple refused the notarization credentials for team $TEAM (check the Apple ID and the app-specific password)." >&2
  exit 1
fi
echo "Notarization credentials accepted by Apple."

# ── Updater key ───────────────────────────────────────────────────────────────
if [ ! -f "$UKEY" ]; then
  /usr/bin/openssl rand -hex 24 | tr -d "\n" > "$UPASS"
  chmod 600 "$UPASS"
  npx --prefix "$(dirname "$0")/../desktop" tauri signer generate -w "$UKEY" -p "$(cat "$UPASS")" --ci >/dev/null
  chmod 600 "$UKEY"
  echo "Created the updater key. Put $UKEY.pub into tauri.conf.json › plugins.updater.pubkey."
fi

# ── Upload ────────────────────────────────────────────────────────────────────
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh api -X PUT "repos/$REPO/environments/release" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
if ! gh api "repos/$REPO/environments/release/deployment-branch-policies" --jq '.branch_policies[] | select(.type=="tag") | .name' | grep -qx 'v\*'; then
  gh api -X POST "repos/$REPO/environments/release/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null
fi
base64 -i "$P12" | gh secret set APPLE_CERTIFICATE --env release
gh secret set APPLE_CERTIFICATE_PASSWORD --env release < "$PASSFILE"
printf %s "$APPLE_ID" | gh secret set APPLE_ID --env release
printf %s "$APPLE_PASSWORD" | gh secret set APPLE_PASSWORD --env release
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < "$UKEY"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release < "$UPASS"
gh variable set APPLE_SIGNING_IDENTITY --env release --body "$SHA1"
gh variable set APPLE_TEAM_ID --env release --body "$TEAM"

echo "✓ $REPO environment \"release\" (v* tags only): APPLE_CERTIFICATE(_PASSWORD), APPLE_ID, APPLE_PASSWORD,"
echo "  TAURI_SIGNING_PRIVATE_KEY(_PASSWORD); variables APPLE_SIGNING_IDENTITY=$SHA1, APPLE_TEAM_ID=$TEAM."
