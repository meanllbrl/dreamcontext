#!/bin/sh
# dreamcontext install script
# Review this script before piping it to sh: https://www.npmjs.com/package/dreamcontext
set -e

NODE_MIN_MAJOR=18
BREW_INSTALLER_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

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

# Ask the user a yes/no question. Works in a piped install (stdin is not a
# terminal) by reading /dev/tty. Answers "no" when there is no terminal at
# all, so an unattended run never silently installs a package manager.
confirm() {
  if [ -n "${DREAMCONTEXT_INSTALL_YES:-}" ]; then
    return 0
  fi
  if [ -t 0 ]; then
    printf '%s [y/N] ' "$1"
    read -r reply || return 1
  elif has_tty; then
    printf '%s [y/N] ' "$1" > /dev/tty
    read -r reply < /dev/tty || return 1
  else
    return 1
  fi
  case "$reply" in
    y | Y | yes | Yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# /dev/tty can exist and look readable while being impossible to open (a
# detached process). Prove it opens before trying to prompt on it.
has_tty() {
  { : < /dev/tty; } 2> /dev/null
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

install_brew() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "Homebrew is not installed. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org (or your package manager), then re-run this script."
  fi
  have curl || die "curl is required to install Homebrew. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org instead, then re-run this script."

  say ""
  say "Node.js is missing and Homebrew (the macOS package manager) is not installed either."
  say "Homebrew's official installer will run from: ${BREW_INSTALLER_URL}"
  say "It asks for your macOS password and may install Apple's Command Line Tools first (this can take a few minutes)."
  if ! confirm "Install Homebrew now?"; then
    die "Skipped Homebrew. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org yourself, then re-run this script."
  fi

  # Downloaded to a file and then executed (never piped straight into a shell)
  # so the script on disk is the script that runs and can be inspected.
  brew_installer=$(mktemp)
  curl -fsSL "$BREW_INSTALLER_URL" -o "$brew_installer" \
    || die "Could not download the Homebrew installer from ${BREW_INSTALLER_URL}."
  if has_tty; then
    # Homebrew needs a terminal to prompt for the administrator password.
    /bin/bash "$brew_installer" < /dev/tty || die "Homebrew installation failed. See the output above."
  else
    NONINTERACTIVE=1 /bin/bash "$brew_installer" || die "Homebrew installation failed. See the output above."
  fi
  rm -f "$brew_installer"

  find_brew || die "Homebrew installed but 'brew' is still not on PATH. Open a new terminal and re-run this script."
  persist_brew_path
  say "Homebrew $(brew --version 2>/dev/null | head -n 1) installed."
}

install_node() {
  say "Installing Node.js with Homebrew..."
  brew install node || die "Homebrew could not install Node.js. Run 'brew install node' manually, then re-run this script."
  hash -r 2> /dev/null || true
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
    say "Node.js $(node --version) is too old — dreamcontext requires v${NODE_MIN_MAJOR} or later."
  fi

  if ! find_brew; then
    install_brew
  fi
  install_node

  if ! node_is_ready; then
    die "Node.js >= ${NODE_MIN_MAJOR} is still not the active version after the install. Open a NEW terminal and run 'node --version'. If it is still missing or too old, another Node.js (nvm, asdf, /usr/local) is earlier on your PATH — fix that, then re-run this script."
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
