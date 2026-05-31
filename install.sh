#!/bin/sh
# dreamcontext install script
# Review this script before piping it to sh: https://www.npmjs.com/package/dreamcontext
set -e

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

check_node() {
  if ! command -v node > /dev/null 2>&1; then
    die "Node.js is not installed. Install it from https://nodejs.org (v18 or later required), then re-run this script."
  fi
  if ! command -v npm > /dev/null 2>&1; then
    die "npm is not installed. Install Node.js (which includes npm) from https://nodejs.org, then re-run this script."
  fi
  node_major=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [ "$node_major" -lt 18 ]; then
    die "Node.js v${node_major} is too old. dreamcontext requires Node.js >= 18. Upgrade at https://nodejs.org, then re-run this script."
  fi
  say "Node.js $(node --version) detected."
}

install_cli() {
  say "Installing dreamcontext..."
  # Installs the published dreamcontext CLI from npm. Review this script before piping it to sh.
  npm install -g dreamcontext@latest
}

verify() {
  if ! dreamcontext --version > /dev/null 2>&1; then
    die "Installation verification failed: 'dreamcontext --version' did not succeed. Check the npm install output above for errors."
  fi
  installed_version=$(dreamcontext --version 2>/dev/null || true)
  say "dreamcontext ${installed_version} installed successfully."
}

maybe_setup() {
  if [ -d "_dream_context" ]; then
    say "Existing _dream_context/ detected. Running 'dreamcontext update'..."
    dreamcontext update
    return
  fi

  if [ -n "${DREAMCONTEXT_INSTALL_NO_SETUP:-}" ]; then
    say "DREAMCONTEXT_INSTALL_NO_SETUP is set. Skipping setup."
    say "Run \`dreamcontext setup\` to finish."
    exit 0
  fi

  if [ -t 0 ]; then
    say "Running 'dreamcontext setup' to initialize your project..."
    dreamcontext setup
  else
    say "Run \`dreamcontext setup\` to finish."
    exit 0
  fi
}

main() {
  say "==> dreamcontext installer"
  check_node
  install_cli
  verify
  maybe_setup
}

main
