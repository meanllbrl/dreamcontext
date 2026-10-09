#!/bin/sh
# dreamcontext install script
# Review this script before piping it to sh: https://www.npmjs.com/package/dreamcontext
set -e

NODE_MIN_MAJOR=18

# The private Node.js build installed when this computer has no usable Node and no
# Homebrew. These values MIRROR assets/runtime-pins.json (the desktop app reads the same
# file); tests/unit/runtime-pins-mirror.test.ts fails the moment the two disagree.
NODE_VERSION="24.21.0"
NODE_MIN_MACOS="13.5"
NODE_BASE_URL="https://nodejs.org/dist/v24.21.0/"
# The comment header above the PATH lines, shared with the app (NODE_RC_MARKER in
# src/lib/claude-path.ts) so either one recognises a profile the other already set up.
NODE_RC_MARKER="# dreamcontext: Node.js on PATH"

say() {
  printf '%s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" > /dev/null 2>&1
}

node_major() {
  if ! have node; then
    printf '0'
    return
  fi
  node -e "process.stdout.write(String(process.versions.node.split('.')[0]))" 2> /dev/null || printf '0'
}

node_is_ready() {
  have node || return 1
  have npm || return 1
  major=$(node_major)
  [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

# Homebrew installs to /opt/homebrew (Apple Silicon) or /usr/local (Intel), and
# neither is guaranteed to be on PATH in a non-login shell. Find an existing
# install and put it on PATH for the rest of this script.
find_brew() {
  if have brew; then
    return 0
  fi
  for candidate in /opt/homebrew /usr/local /home/linuxbrew/.linuxbrew "$HOME/.linuxbrew"; do
    if [ -x "$candidate/bin/brew" ]; then
      PATH="$candidate/bin:$PATH"
      export PATH
      return 0
    fi
  done
  return 1
}

# Make brew's bin directory survive this shell, so the `dreamcontext` binary npm
# puts there is still on PATH in the user's next terminal. Idempotent, and a
# no-op when Homebrew's own installer already wrote a shellenv line.
persist_brew_path() {
  brew_bin=$(dirname "$(command -v brew)")
  rc=""
  case "${SHELL:-}" in
    */zsh) rc="$HOME/.zprofile" ;;
    */bash) rc="$HOME/.bash_profile" ;;
    */fish) rc="$HOME/.config/fish/config.fish" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -f "$rc" ] && grep -q -e "brew shellenv" -e "$brew_bin" "$rc" 2> /dev/null; then
    return
  fi
  mkdir -p "$(dirname "$rc")"
  {
    printf '\n# dreamcontext: added Homebrew to PATH\n'
    case "$rc" in
      */config.fish) printf 'set -gx PATH "%s" $PATH\n' "$brew_bin" ;;
      *) printf 'export PATH="%s:$PATH"\n' "$brew_bin" ;;
    esac
  } >> "$rc"
  say "Added Homebrew to your PATH in $rc."
}

install_node() {
  say "Installing Node.js with Homebrew..."
  brew install node || die "Homebrew could not install Node.js. Run 'brew install node' manually, then re-run this script."
  hash -r 2> /dev/null || true
}

# ─── The private Node.js (no Homebrew) ────────────────────────────────────────
#
# Same layout the desktop app builds (desktop/src-tauri/src/node_runtime.rs), so the app
# and the CLI share ONE private Node:
#
#   ~/.dreamcontext/node/<version>/          the official build, unpacked
#   ~/.dreamcontext/node/<version>/etc/npmrc prefix=<home>/.dreamcontext/npm-global
#   ~/.dreamcontext/node/current -> <version>
#   ~/.dreamcontext/npm-global/              global npm packages (the dreamcontext CLI),
#                                            outside the version folder so a pin bump keeps them
#
# No admin password, no package manager, nothing outside ~/.dreamcontext and one PATH line
# in the shell profile. Nothing is ever written through a symlink.

# `darwin-arm64`, `linux-x64`, ...: the key of this computer's build in the pin table.
node_platform_key() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) return 1 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# Set NODE_PIN_FILE / NODE_PIN_SHA256 / NODE_PIN_SIZE for one platform key.
node_pin_for() {
  case "$1" in
    darwin-arm64) NODE_PIN_FILE="node-v24.21.0-darwin-arm64.tar.gz"; NODE_PIN_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"; NODE_PIN_SIZE=52909993 ;;
    darwin-x64) NODE_PIN_FILE="node-v24.21.0-darwin-x64.tar.gz"; NODE_PIN_SHA256="1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"; NODE_PIN_SIZE=54203979 ;;
    linux-x64) NODE_PIN_FILE="node-v24.21.0-linux-x64.tar.gz"; NODE_PIN_SHA256="6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"; NODE_PIN_SIZE=58088022 ;;
    linux-arm64) NODE_PIN_FILE="node-v24.21.0-linux-arm64.tar.gz"; NODE_PIN_SHA256="724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"; NODE_PIN_SIZE=57824078 ;;
    *) return 1 ;;
  esac
}

# Is this Mac at least macOS $1 (major.minor)?
macos_at_least() {
  have_version=$(sw_vers -productVersion 2> /dev/null) || return 1
  have_major=${have_version%%.*}
  have_rest=${have_version#*.}
  [ "$have_rest" = "$have_version" ] && have_rest=0
  have_minor=${have_rest%%.*}
  need_major=${1%%.*}
  need_minor=${1#*.}
  [ "$have_major" -gt "$need_major" ] && return 0
  [ "$have_major" -eq "$need_major" ] && [ "$have_minor" -ge "$need_minor" ]
}

sha256_of() {
  if have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}

# Refuse to write through a symlink: a link here could point the install anywhere.
refuse_link() {
  if [ -L "$1" ]; then
    die "$1 is a link, so dreamcontext will not install Node.js through it. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead, then re-run this script."
  fi
}

# Point `current` at a version folder. A new link under a temp name is renamed over the old
# one, so `current` is never missing: GNU mv takes -T, BSD (macOS) mv takes -h, and both stop
# mv from moving the new link INTO the folder the old link points at.
swap_current() {
  swap_tmp="$1/.current-$$"
  rm -f "$swap_tmp"
  ln -s "$2" "$swap_tmp" || return 1
  if mv -fT "$swap_tmp" "$1/current" 2> /dev/null || mv -fh "$swap_tmp" "$1/current" 2> /dev/null; then
    return 0
  fi
  rm -f "$swap_tmp"
  ln -sfn "$2" "$1/current"
}

# Remove this run's temporary folders, then stop with a message.
managed_fail() {
  rm -rf "$managed_work" "$managed_staging"
  die "$1"
}

install_managed_node() {
  key=$(node_platform_key) || die "There is no private Node.js build for this computer. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org (or your package manager), then re-run this script."
  node_pin_for "$key" || die "There is no private Node.js build for this computer. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org (or your package manager), then re-run this script."
  if [ "${key%%-*}" = "darwin" ] && ! macos_at_least "$NODE_MIN_MACOS"; then
    die "The private Node.js needs macOS ${NODE_MIN_MACOS} or later. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org, then re-run this script."
  fi
  have curl || die "curl is required to download Node.js. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead, then re-run this script."
  have tar || die "tar is required to unpack Node.js. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead, then re-run this script."

  dc_home="$HOME/.dreamcontext"
  node_root="$dc_home/node"
  npm_global="$dc_home/npm-global"
  dest="$node_root/$NODE_VERSION"
  case "$npm_global" in
    *"
"* | *"$(printf '\r')"*) die "Your home folder path cannot be written to npm's settings. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead." ;;
  esac
  refuse_link "$dc_home"
  refuse_link "$node_root"
  refuse_link "$dest"
  refuse_link "$npm_global"
  mkdir -p "$node_root" || die "Could not create $node_root."
  if [ -e "$node_root/current" ] && [ ! -L "$node_root/current" ]; then
    die "$node_root/current is a folder, not a link. Move it away, then re-run this script."
  fi

  managed_work=""
  managed_staging=""
  # A private folder only this user can read (mktemp -d creates it 0700).
  managed_work=$(mktemp -d) || die "Could not create a temporary folder."
  archive="$managed_work/$NODE_PIN_FILE"

  say "Downloading Node.js ${NODE_VERSION}, a private copy just for dreamcontext. Your other apps are not touched."
  curl -fsSL --proto '=https' --tlsv1.2 -o "$archive" "${NODE_BASE_URL}${NODE_PIN_FILE}" \
    || managed_fail "Could not download Node.js. Check your internet connection, then re-run this script."

  size=$(wc -c < "$archive" | tr -d ' ')
  [ "$size" = "$NODE_PIN_SIZE" ] \
    || managed_fail "The Node.js download was the wrong size, so it was thrown away. Re-run this script."
  sum=$(sha256_of "$archive") || managed_fail "Neither shasum nor sha256sum is available to check the download."
  [ "$sum" = "$NODE_PIN_SHA256" ] \
    || managed_fail "The Node.js download did not match its checksum, so it was thrown away. Re-run this script."

  # Staging lives next to its final place (same filesystem, so the final move is a rename)
  # and is created fresh: mkdir fails rather than reuse a folder someone else made.
  managed_staging="$node_root/.partial-$$-$(date +%s)"
  mkdir "$managed_staging" || managed_fail "Could not create a staging folder in $node_root."
  mkdir "$managed_staging/root" || managed_fail "Could not create a staging folder in $node_root."
  tar -xzf "$archive" -C "$managed_staging/root" --strip-components=1 \
    || managed_fail "Could not unpack Node.js."

  # Anything already at <version> is moved aside first, so the move into place never
  # lands inside an existing folder.
  aside=""
  if [ -e "$dest" ]; then
    aside="$dest.old-$(date +%s)"
    mv "$dest" "$aside" || managed_fail "Could not move the old copy of Node.js aside."
  fi
  mv "$managed_staging/root" "$dest" || managed_fail "Could not move Node.js into place."
  rm -rf "$managed_staging" "$managed_work"
  managed_staging=""
  managed_work=""

  refuse_link "$dest/etc"
  mkdir -p "$dest/etc"
  refuse_link "$dest/etc/npmrc"
  printf 'prefix=%s\n' "$npm_global" > "$dest/etc/npmrc"
  mkdir -p "$npm_global"

  swap_current "$node_root" "$NODE_VERSION" || die "Could not point $node_root/current at Node.js ${NODE_VERSION}."

  installed=$("$node_root/current/bin/node" --version 2> /dev/null) \
    || die "The private Node.js did not start. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead, then re-run this script."
  installed_major=${installed#v}
  installed_major=${installed_major%%.*}
  [ "$installed_major" -ge "$NODE_MIN_MAJOR" ] 2> /dev/null \
    || die "The private Node.js reported an unexpected version (${installed})."
  if [ -n "$aside" ]; then
    rm -rf "$aside"
  fi

  PATH="$node_root/current/bin:$npm_global/bin:$PATH"
  export PATH
  npm_config_prefix="$npm_global"
  export npm_config_prefix
  hash -r 2> /dev/null || true
  persist_node_path
  say "Node.js ${installed} installed in $node_root."
}

# The shell profile file(s) to extend: the same targets the app writes (rcTargets in
# src/lib/claude-path.ts), so neither adds a second copy of a line the other wrote.
persist_node_path() {
  case "${SHELL:-}" in
    */fish) persist_node_path_in "$HOME/.config/fish/config.fish" ;;
    */bash)
      persist_node_path_in "$HOME/.bashrc"
      if [ -f "$HOME/.bash_profile" ]; then
        persist_node_path_in "$HOME/.bash_profile"
      fi
      ;;
    */zsh | "") persist_node_path_in "$HOME/.zshrc" ;;
    *) persist_node_path_in "$HOME/.profile" ;;
  esac
}

# Append the PATH lines to one profile, once. The lines name a literal `$HOME/...` (single
# quotes below keep it unexpanded) so they stay right if the home folder is ever renamed.
persist_node_path_in() {
  rc_file=$1
  need_node=1
  need_npm=1
  if [ -f "$rc_file" ]; then
    if grep -qF '$HOME/.dreamcontext/node/current/bin' "$rc_file" || grep -qF "$HOME/.dreamcontext/node/current/bin" "$rc_file"; then
      need_node=0
    fi
    if grep -qF '$HOME/.dreamcontext/npm-global/bin' "$rc_file" || grep -qF "$HOME/.dreamcontext/npm-global/bin" "$rc_file"; then
      need_npm=0
    fi
  fi
  if [ "$need_node" = 0 ] && [ "$need_npm" = 0 ]; then
    return 0
  fi
  mkdir -p "$(dirname "$rc_file")"
  {
    printf '\n%s\n' "$NODE_RC_MARKER"
    case "$rc_file" in
      */config.fish)
        [ "$need_node" = 1 ] && printf '%s\n' 'set -gx PATH "$HOME/.dreamcontext/node/current/bin" $PATH'
        [ "$need_npm" = 1 ] && printf '%s\n' 'set -gx PATH "$HOME/.dreamcontext/npm-global/bin" $PATH'
        ;;
      *)
        [ "$need_node" = 1 ] && printf '%s\n' 'export PATH="$HOME/.dreamcontext/node/current/bin:$PATH"'
        [ "$need_npm" = 1 ] && printf '%s\n' 'export PATH="$HOME/.dreamcontext/npm-global/bin:$PATH"'
        ;;
    esac
    true
  } >> "$rc_file"
  say "Added Node.js to your PATH in $rc_file."
}

ensure_node() {
  if node_is_ready; then
    say "Node.js $(node --version) detected."
    return
  fi

  if [ -n "${DREAMCONTEXT_INSTALL_NO_NODE:-}" ]; then
    die "Node.js >= ${NODE_MIN_MAJOR} is required and DREAMCONTEXT_INSTALL_NO_NODE is set. Install it from https://nodejs.org, then re-run this script."
  fi

  if ! have node; then
    say "Node.js is not installed."
  elif ! have npm; then
    say "Node.js $(node --version) is installed but npm is missing."
  else
    say "Node.js $(node --version) is too old. dreamcontext requires v${NODE_MIN_MAJOR} or later."
  fi

  if have brew; then
    install_node
  elif find_brew; then
    # Homebrew is here but not on this shell's PATH: keep it on PATH for the next terminal too.
    install_node
    persist_brew_path
  else
    install_managed_node
  fi

  if ! node_is_ready; then
    die "Node.js >= ${NODE_MIN_MAJOR} is still not the active version after the install. Open a NEW terminal and run 'node --version'. If it is still missing or too old, another Node.js (nvm, asdf, /usr/local) is earlier on your PATH. Fix that, then re-run this script."
  fi
  say "Node.js $(node --version) ready."
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

maybe_install_app() {
  # macOS ONLY: also place the desktop app in ~/Applications. The app is NOT in
  # the npm package — the CLI fetches it from GitHub Releases (curl/ditto, so no
  # quarantine bit, no Apple notarization prompt). Best-effort: if no desktop
  # release is published yet, or the download fails, this is a no-op and never
  # aborts the CLI install. Non-macOS platforms skip it entirely.
  if [ "$(uname -s)" != "Darwin" ]; then
    return
  fi
  if [ -n "${DREAMCONTEXT_INSTALL_NO_APP:-}" ]; then
    say "DREAMCONTEXT_INSTALL_NO_APP is set. Skipping desktop app install."
    return
  fi
  say "Installing the dreamcontext desktop app (macOS)..."
  dreamcontext app install || say "Desktop app not installed yet — run 'dreamcontext app install' later."
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
  ensure_node
  install_cli
  verify
  maybe_install_app
  maybe_setup
}

main
