#!/usr/bin/env bash
# One-time setup for the desktop release signature (see the "Sign" step in
# .github/workflows/desktop-release.yml).
#
# An ad-hoc signature's designated requirement is the bundle's cdhash, so every
# release is a stranger to macOS TCC and every user is asked for file, microphone
# and automation access again after each update. Signing every release with ONE
# self-signed certificate makes the requirement
#   identifier "com.dreamcontext.beta" and certificate leaf = H"<sha1>"
# which all releases share, so the grants survive updates.
#
# This script creates that certificate ONCE, keeps a backup under
# ~/.dreamcontext/release-signing/, and stores it via `gh` in the repo's
# `release` environment, which only `v*` tags can deploy to — so a workflow on
# any branch (or a fork PR) can never read the private key. Re-running reuses the backup and only re-uploads.
# Losing the backup means a new certificate, and every user re-grants once.
set -euo pipefail

CN="dreamcontext Release Signing"
DIR="$HOME/.dreamcontext/release-signing"
P12="$DIR/release.p12"
PASSFILE="$DIR/release.p12.password"
CERT="$DIR/release.cert.pem"

mkdir -p "$DIR"
chmod 700 "$DIR"

if [ -f "$P12" ] && [ -f "$PASSFILE" ] && [ -f "$CERT" ]; then
  echo "Reusing the existing certificate in $DIR"
else
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name=dn
prompt=no
x509_extensions=ext
[dn]
CN=$CN
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF
  # The system LibreSSL writes a PKCS#12 that `security import` reads; OpenSSL 3 does not by default.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -keyout "$WORK/key.pem" -out "$CERT" -config "$WORK/cert.cnf" 2>/dev/null
  /usr/bin/openssl rand -hex 24 | tr -d "\n" > "$PASSFILE"  # no newline: the secret must equal what openssl read
  /usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$CERT" -out "$P12" \
    -passout "file:$PASSFILE"
  chmod 600 "$P12" "$PASSFILE" "$CERT"
  echo "Created \"$CN\" in $DIR — back this folder up (1Password or similar)."
fi

SHA1="$(/usr/bin/openssl x509 -in "$CERT" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')"

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
# Environment that only `v*` tags may deploy to (idempotent).
gh api -X PUT "repos/$REPO/environments/release" --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
if ! gh api "repos/$REPO/environments/release/deployment-branch-policies" --jq '.branch_policies[] | select(.type=="tag") | .name' | grep -qx 'v\*'; then
  gh api -X POST "repos/$REPO/environments/release/deployment-branch-policies" -f name='v*' -f type=tag >/dev/null
fi

# Values go through stdin, never argv. base64 on macOS writes one line, so log masking holds.
base64 -i "$P12" | gh secret set MACOS_SIGNING_P12 --env release
gh secret set MACOS_SIGNING_P12_PASSWORD --env release < "$PASSFILE"
gh variable set MACOS_SIGNING_CERT_SHA1 --env release --body "$SHA1"

echo "✓ $REPO environment \"release\" (v* tags only): secrets MACOS_SIGNING_P12, MACOS_SIGNING_P12_PASSWORD, variable MACOS_SIGNING_CERT_SHA1."
echo "  Releases will carry: designated => identifier \"com.dreamcontext.beta\" and certificate leaf = H\"$SHA1\""
