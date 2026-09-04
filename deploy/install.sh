#!/usr/bin/env bash
# SillyTavern Multiplayer — remote/VPS installer.
#
# Sets up the relay server, TLS + login, the extension symlink into your
# SillyTavern install, and (optionally) the headless-browser keeper that
# keeps the extension connected 24/7 without a real browser open.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/CozyJames/sillytavern-mp/master/deploy/install.sh | bash
# or, from an existing checkout:
#   bash deploy/install.sh
#
# Safe to re-run: existing checkouts are `git pull`ed instead of re-cloned,
# and systemd units are rewritten + restarted rather than duplicated.

set -euo pipefail

REPO_URL="https://github.com/CozyJames/sillytavern-mp.git"

# ──────────── Helpers ────────────

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
ask()   { # ask <prompt> <default> -> echoes the answer
  local prompt="$1" default="${2:-}" reply
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " reply
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply
    echo "$reply"
  fi
}
ask_yn() { # ask_yn <prompt> <default: y|n> -> returns 0 for yes, 1 for no
  local prompt="$1" default="${2:-y}" reply
  local hint="y/n"; [ "$default" = "y" ] && hint="Y/n" || hint="y/N"
  read -r -p "$prompt [$hint]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

if [ "$(id -u)" -eq 0 ]; then RUN_AS_ROOT=1; PRIV=""; else RUN_AS_ROOT=0; PRIV="sudo"; fi

for cmd in node npm git openssl; do
  command -v "$cmd" >/dev/null 2>&1 || { warn "'$cmd' is required but not found — install it first."; exit 1; }
done
if [ ! -d /run/systemd/system ]; then
  warn "systemd doesn't appear to be running on this machine — this script sets up systemd services, and needs it. Use install-local.sh instead if this is your own PC, not a systemd-based server."
  exit 1
fi

echo "SillyTavern Multiplayer — remote/VPS install"
echo "This sets up the relay server + web client, TLS, login, the extension"
echo "token, and (optionally) the 24/7 headless-browser keeper."
echo

# ──────────── Where things live ────────────

INSTALL_DIR="$(ask 'Install directory for this repo' "$HOME/sillytavern-mp")"
ST_PATH="$(ask 'Path to your SillyTavern install' "$HOME/SillyTavern")"
ST_USER="$(ask "SillyTavern user folder (usually default-user)" "default-user")"

if [ ! -d "$ST_PATH/data" ]; then
  warn "'$ST_PATH/data' doesn't exist — is that really your SillyTavern install path?"
  ask_yn "Continue anyway?" n || exit 1
fi

# ──────────── Clone or update ────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Found an existing checkout at $INSTALL_DIR — updating it"
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

# ──────────── Symlink the extension into SillyTavern ────────────

EXT_DIR="$ST_PATH/data/$ST_USER/extensions/mp-extension"
info "Linking extension into $EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
ln -sfn "$INSTALL_DIR/extension" "$EXT_DIR"

# ──────────── Public address ────────────

DETECTED_IP="$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || true)"
PUBLIC_ADDR="$(ask 'Public IP or domain players will connect to' "${DETECTED_IP:-your.server.ip}")"

# ──────────── TLS ────────────

CERT_DIR="$INSTALL_DIR/certs"
if ask_yn "Enable HTTPS (self-signed certificate, no domain needed)?" y; then
  USE_TLS=1
  mkdir -p "$CERT_DIR"
  if [ -f "$CERT_DIR/cert.pem" ] && [ -f "$CERT_DIR/key.pem" ]; then
    info "Certificate already exists at $CERT_DIR — keeping it"
  else
    info "Generating a self-signed certificate for $PUBLIC_ADDR"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
      -subj "/CN=sillytavern-mp" \
      -addext "subjectAltName=IP:127.0.0.1,IP:$PUBLIC_ADDR" >/dev/null 2>&1
  fi
else
  USE_TLS=0
  warn "Running without HTTPS — fine on a private LAN/VPN, risky on the open internet."
fi
SCHEME="http"; [ "$USE_TLS" = "1" ] && SCHEME="https"

# ──────────── Login ────────────

if ask_yn "Require a login for anyone connecting from outside this machine?" y; then
  MP_AUTH_USER="$(ask 'Username' "player")"
  MP_AUTH_PASS="$(ask 'Password (leave blank to generate one)' "")"
  if [ -z "$MP_AUTH_PASS" ]; then
    MP_AUTH_PASS="$(openssl rand -hex 8)"
    info "Generated password: $MP_AUTH_PASS  (write this down)"
  fi
else
  MP_AUTH_USER=""
  MP_AUTH_PASS=""
  warn "No login — anyone with the URL can join. Fine on a private LAN/VPN only."
fi

# Extension token: always generated. It's how the extension (which the
# server can't treat as "local" — see README) authenticates without going
# through the login page.
MP_EXTENSION_TOKEN="$(openssl rand -hex 24)"

# ──────────── ST_LOCAL_URL (for the avatar proxy + keeper) ────────────

ST_LOCAL_URL="$(ask 'Address the relay server can reach SillyTavern at' "http://127.0.0.1:8000")"

# ──────────── Extension config ────────────

info "Writing extension/config.local.js"
cat > "$INSTALL_DIR/extension/config.local.js" <<EOF
export const TARGET_URL = '$SCHEME://$PUBLIC_ADDR:3000';
export const AUTH_TOKEN = '$MP_EXTENSION_TOKEN';
EOF

# ──────────── npm install ────────────

info "Installing server dependencies"
(cd "$INSTALL_DIR/server" && npm install --omit=dev --no-audit --no-fund)

# ──────────── Keeper (24/7 headless browser) ────────────

INSTALL_KEEPER=0
if ask_yn "Install the headless-browser keeper (keeps the extension connected without a real browser open)?" y; then
  INSTALL_KEEPER=1
  if command -v apt-get >/dev/null 2>&1; then
    info "Installing Chromium"
    $PRIV apt-get update -qq
    $PRIV apt-get install -y chromium >/dev/null
  else
    warn "No apt-get found — install a Chromium/Chrome browser manually, then set CHROME_PATH in the keeper's systemd unit."
  fi
  info "Installing keeper dependencies"
  (cd "$INSTALL_DIR/keeper" && npm install --omit=dev --no-audit --no-fund)
fi

# ──────────── systemd units ────────────

NODE_BIN="$(command -v node)"

info "Writing systemd unit for the relay server"
$PRIV tee /etc/systemd/system/sillytavern-mp.service >/dev/null <<EOF
[Unit]
Description=SillyTavern Multiplayer relay server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/server
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=5
Environment=MP_AUTH_USER=$MP_AUTH_USER
Environment=MP_AUTH_PASS=$MP_AUTH_PASS
Environment=MP_EXTENSION_TOKEN=$MP_EXTENSION_TOKEN
$( [ "$USE_TLS" = "1" ] && echo "Environment=MP_TLS_CERT=$CERT_DIR/cert.pem" )
$( [ "$USE_TLS" = "1" ] && echo "Environment=MP_TLS_KEY=$CERT_DIR/key.pem" )
Environment=ST_LOCAL_URL=$ST_LOCAL_URL

[Install]
WantedBy=multi-user.target
EOF

if [ "$INSTALL_KEEPER" = "1" ]; then
  CHROME_PATH="$(command -v chromium-browser || command -v chromium || echo /usr/bin/chromium-browser)"
  info "Writing systemd unit for the keeper"
  $PRIV tee /etc/systemd/system/tavern-keeper.service >/dev/null <<EOF
[Unit]
Description=Headless browser keeping the ST tab (and mp-extension) alive
After=sillytavern-mp.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/keeper
ExecStart=$NODE_BIN keeper.js
Environment=ST_URL=$ST_LOCAL_URL
Environment=CHROME_PATH=$CHROME_PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

$PRIV systemctl daemon-reload
$PRIV systemctl enable --now sillytavern-mp
[ "$INSTALL_KEEPER" = "1" ] && $PRIV systemctl enable --now tavern-keeper

# ──────────── State file (for uninstall.sh) ────────────

cat > "$INSTALL_DIR/.mp-install-state" <<EOF
INSTALL_DIR=$INSTALL_DIR
ST_PATH=$ST_PATH
ST_USER=$ST_USER
MODE=remote
KEEPER_INSTALLED=$INSTALL_KEEPER
EOF

# ──────────── Done ────────────

echo
info "Done. Restart SillyTavern to pick up the extension, then:"
echo "  Web client: $SCHEME://$PUBLIC_ADDR:3000"
[ -n "$MP_AUTH_USER" ] && echo "  Login: $MP_AUTH_USER / $MP_AUTH_PASS"
echo "  Server status:  systemctl status sillytavern-mp"
[ "$INSTALL_KEEPER" = "1" ] && echo "  Keeper status:  systemctl status tavern-keeper"
echo "  Logs:           journalctl -u sillytavern-mp -f"
