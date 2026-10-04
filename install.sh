#!/usr/bin/env bash
# Agent of Empires: Supercharge installer (macOS and Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/xsoladdd/aoe-supercharge/main/install.sh | bash
#   bash install.sh [--yes] [--dry-run] [--local <repo-path>]
#
# Shows every dependency it would install first and asks before changing anything (unless --yes).
# Written in the common subset of bash and zsh, so `zsh install.sh` works too.
set -eu
# zsh does not word-split unquoted variables by default; this script relies on it (dependency lists).
if [ -n "${ZSH_VERSION:-}" ]; then setopt SH_WORD_SPLIT; fi

YES=0
DRY=0
LOCAL=""
NODE_MAJOR=24
PKG="aoe-supercharge"

usage() {
  cat <<'EOF'
Usage: install.sh [--yes] [--dry-run] [--local <repo-path>]

  --yes          install without asking
  --dry-run      print the plan and exit; change nothing
  --local PATH   install Supercharge from a local checkout instead of npm
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=1 ;;
    -n | --dry-run) DRY=1 ;;
    --local)
      shift
      LOCAL="${1:-}"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B="$(printf '\033[1m')"; G="$(printf '\033[32m')"; Y="$(printf '\033[33m')"; R="$(printf '\033[31m')"; D="$(printf '\033[2m')"; X="$(printf '\033[0m')"
else
  B=""; G=""; Y=""; R=""; D=""; X=""
fi
ok() { printf '%s✓%s %s\n' "$G" "$X" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$X" "$1"; }
fail() { printf '%s✗%s %s\n' "$R" "$X" "$1" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── platform ──────────────────────────────────────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux) PLATFORM="linux" ;;
  *)
    fail "Unsupported OS: $OS. Supercharge runs on macOS and Linux (on Windows, use WSL2)."
    exit 1
    ;;
esac

PM=""
if [ "$PLATFORM" = "macos" ]; then
  if have brew; then PM="brew"; fi
else
  if have apt-get; then PM="apt"; elif have dnf; then PM="dnf"; elif have pacman; then PM="pacman"; elif have brew; then PM="brew"; fi
fi
SUDO=""
if [ "$PM" != "brew" ] && [ "$(id -u)" -ne 0 ]; then SUDO="sudo "; fi

# ── per-dependency checks and install commands ───────────────────────────────
version_of() {
  case "$1" in
    git) git --version 2>/dev/null | awk '{print $3}' ;;
    tmux) tmux -V 2>/dev/null | awk '{print $2}' ;;
    node) node --version 2>/dev/null | sed 's/^v//' ;;
    claude) claude --version 2>/dev/null | awk '{print $1}' ;;
    aoe) aoe --version 2>/dev/null | awk '{print $2}' ;;
    glab) glab version 2>/dev/null | awk 'NR==1{print $2}' ;;
  esac
}

needs_install() {
  if ! have "$1"; then return 0; fi
  if [ "$1" = "node" ]; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$major" -lt "$NODE_MAJOR" ] && return 0
  fi
  return 1
}

install_cmd() {
  dep="$1"
  case "$dep:$PM" in
    git:brew | tmux:brew | glab:brew) echo "brew install $dep" ;;
    node:brew) echo "brew install node@$NODE_MAJOR && brew link --overwrite --force node@$NODE_MAJOR" ;;
    aoe:brew) echo "brew install aoe" ;;
    git:apt | tmux:apt) echo "${SUDO}apt-get update && ${SUDO}apt-get install -y $dep" ;;
    git:dnf | tmux:dnf | glab:dnf) echo "${SUDO}dnf install -y $dep" ;;
    git:pacman | tmux:pacman | glab:pacman) echo "${SUDO}pacman -S --noconfirm $dep" ;;
    node:apt) echo "curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | ${SUDO}bash - && ${SUDO}apt-get install -y nodejs" ;;
    node:dnf) echo "curl -fsSL https://rpm.nodesource.com/setup_$NODE_MAJOR.x | ${SUDO}bash - && ${SUDO}dnf install -y nodejs" ;;
    node:pacman) echo "${SUDO}pacman -S --noconfirm nodejs-lts-krypton npm" ;;
    glab:apt) echo "${SUDO}apt-get update && ${SUDO}apt-get install -y glab" ;;
    claude:*) echo "curl -fsSL https://claude.ai/install.sh | bash" ;;
    aoe:*) echo "curl -fsSL https://raw.githubusercontent.com/agent-of-empires/agent-of-empires/main/scripts/install.sh | bash" ;;
    *) echo "" ;;
  esac
}

DEPS="git tmux node claude aoe glab"
TODO=""

printf '\n%sAgent of Empires: Supercharge installer%s\n' "$B" "$X"
printf '%sPlatform: %s, package manager: %s%s\n\n' "$D" "$PLATFORM" "${PM:-none found}" "$X"
for dep in $DEPS; do
  label="$dep"
  [ "$dep" = "node" ] && label="node (>= $NODE_MAJOR LTS)"
  if needs_install "$dep"; then
    cmd="$(install_cmd "$dep")"
    current="$(version_of "$dep")"
    if [ -n "$current" ]; then state="v$current is too old"; else state="missing"; fi
    if [ -z "$cmd" ]; then
      printf '  %s✗%s %-22s %s; no automatic install for this system (see README#dependencies)\n' "$R" "$X" "$label" "$state"
    else
      printf '  %s+%s %-22s %s; will run: %s%s%s\n' "$Y" "$X" "$label" "$state" "$D" "$cmd" "$X"
      TODO="$TODO $dep"
    fi
  else
    printf '  %s✓%s %-22s %s\n' "$G" "$X" "$label" "$(version_of "$dep")"
  fi
done
if [ -n "$LOCAL" ]; then SC_CMD="npm run build --prefix \"$LOCAL\" && npm install -g \"$LOCAL/packages/cli\""; else SC_CMD="npm install -g $PKG"; fi
printf '  %s+%s %-22s will run: %s%s%s\n\n' "$Y" "$X" "supercharge" "$D" "$SC_CMD" "$X"

if [ "$DRY" -eq 1 ]; then
  echo "Dry run: nothing was changed."
  exit 0
fi

if [ "$YES" -ne 1 ]; then
  if [ -r /dev/tty ]; then
    printf 'Proceed? [y/N] '
    read -r answer </dev/tty || answer=""
  else
    answer=""
  fi
  case "$answer" in
    y | Y | yes | YES) ;;
    *)
      echo "Nothing changed. Re-run with --yes to skip this question."
      exit 0
      ;;
  esac
fi

# ── install and verify ───────────────────────────────────────────────────────
for dep in $TODO; do
  cmd="$(install_cmd "$dep")"
  printf '\n%s›%s %s\n' "$B" "$X" "$cmd"
  if ! sh -c "$cmd"; then
    fail "Installing $dep failed. Install it manually (README#dependencies), then re-run this script."
    exit 1
  fi
  # Freshly installed tools may live in a directory the current shell has not seen yet.
  PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PATH
  if needs_install "$dep"; then
    fail "$dep still is not available after installing. Open a new terminal and re-run, or install it manually."
    exit 1
  fi
  ok "$dep $(version_of "$dep")"
done

printf '\n%s›%s %s\n' "$B" "$X" "$SC_CMD"
sh -c "$SC_CMD"
if ! have supercharge; then
  fail "supercharge is not on PATH. Add \"\$(npm prefix -g)/bin\" to PATH and re-run."
  exit 1
fi
ok "supercharge $(supercharge --version)"

printf '\n%sDoctor report%s\n' "$B" "$X"
supercharge doctor || true

cat <<EOF

${B}Next${X}
  supercharge start     install the background service (starts at login)
  supercharge open      sign in and open the dashboard
  cd <repo> && supercharge init     register a project and start its control chat
EOF
