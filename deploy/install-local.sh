#!/usr/bin/env bash
# SillyTavern Multiplayer — local installer.
#
# For running everything on your own machine: SillyTavern, the relay
# server, and the browser tab all stay yours. No TLS, no login, no
# headless-browser keeper — you're the one keeping the tab open, so
# none of that is needed here. For a VPS/remote setup, use install.sh
# instead.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/CozyJames/sillytavern-mp/master/deploy/install-local.sh | bash
# or, from an existing checkout:
#   bash deploy/install-local.sh

set -euo pipefail

REPO_URL="https://github.com/CozyJames/sillytavern-mp.git"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
ask()   {
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply
    echo "$reply"
  fi
}

for cmd in node npm git; do
  command -v "$cmd" >/dev/null 2>&1 || { warn "'$cmd' is required but not found — install it first."; exit 1; }
done

echo "SillyTavern Multiplayer — local install"
echo "Everything stays on this machine: no TLS, no login, no keeper."
echo

INSTALL_DIR="$(ask 'Install directory for this repo' "$HOME/sillytavern-mp")"
ST_PATH="$(ask 'Path to your SillyTavern install' "$HOME/SillyTavern")"
ST_USER="$(ask "SillyTavern user folder (usually default-user)" "default-user")"

if [ ! -d "$ST_PATH/data" ]; then
  warn "'$ST_PATH/data' doesn't exist — is that really your SillyTavern install path?"
  read -r -p "Continue anyway? [y/N]: " reply
  [[ "$reply" =~ ^[Yy] ]] || exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Found an existing checkout at $INSTALL_DIR — updating it"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

EXT_DIR="$ST_PATH/data/$ST_USER/extensions/mp-extension"
info "Linking extension into $EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
ln -sfn "$INSTALL_DIR/extension" "$EXT_DIR"

info "Writing extension/config.local.js"
cat > "$INSTALL_DIR/extension/config.local.js" <<'EOF'
export const TARGET_URL = 'http://localhost:3000';
export const AUTH_TOKEN = '';
EOF

info "Installing server dependencies"
(cd "$INSTALL_DIR/server" && npm install --omit=dev --no-audit --no-fund)

cat > "$INSTALL_DIR/.mp-install-state" <<EOF
INSTALL_DIR=$INSTALL_DIR
ST_PATH=$ST_PATH
ST_USER=$ST_USER
MODE=local
KEEPER_INSTALLED=0
EOF

echo
info "Done. Restart SillyTavern to pick up the extension, then start the server whenever you want to play:"
echo "  cd $INSTALL_DIR/server && node server.js"
echo "  (Windows: double-click server/start.bat instead)"
echo "  Web client: http://localhost:3000"
