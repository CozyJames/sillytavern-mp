#!/usr/bin/env bash
# SillyTavern Multiplayer — uninstaller.
#
# Removes what install.sh/install-local.sh set up: systemd units, the
# extension symlink inside SillyTavern, and (only if you confirm) the
# cloned repo itself. Never touches SillyTavern, Node, or Chromium —
# those are shared system resources, not this project's to remove.
#
# Usage:
#   bash deploy/uninstall.sh
# or, pointing at a checkout elsewhere:
#   bash deploy/uninstall.sh /path/to/sillytavern-mp

set -euo pipefail

info()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!!\033[0m %s\n' "$1"; }
ask_yn() {
  local prompt="$1" default="${2:-n}" reply
  local hint="y/n"; [ "$default" = "y" ] && hint="Y/n" || hint="y/N"
  read -r -p "$prompt [$hint]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

if [ "$(id -u)" -eq 0 ]; then PRIV=""; else PRIV="sudo"; fi

# ──────────── Find the install ────────────

CANDIDATE="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE=""

for dir in "$CANDIDATE" "$SCRIPT_DIR/.." "$HOME/sillytavern-mp"; do
  [ -n "$dir" ] && [ -f "$dir/.mp-install-state" ] && STATE_FILE="$dir/.mp-install-state" && break
done

if [ -z "$STATE_FILE" ]; then
  warn "Couldn't find a .mp-install-state file (created by install.sh/install-local.sh)."
  read -r -p "Path to the sillytavern-mp checkout: " dir
  [ -f "$dir/.mp-install-state" ] || { warn "No .mp-install-state there either — nothing to go on, stopping."; exit 1; }
  STATE_FILE="$dir/.mp-install-state"
fi

# shellcheck disable=SC1090
source "$STATE_FILE"
info "Found install state: $STATE_FILE"
echo "  INSTALL_DIR=$INSTALL_DIR"
echo "  ST_PATH=$ST_PATH"
echo "  ST_USER=$ST_USER"
echo "  MODE=$MODE"
echo "  KEEPER_INSTALLED=$KEEPER_INSTALLED"
echo

ask_yn "Remove this install (systemd units + the extension symlink)?" n || { echo "Nothing done."; exit 0; }

# ──────────── systemd units ────────────

HAD_UNIT=0
for unit in sillytavern-mp tavern-keeper; do
  if [ -f "/etc/systemd/system/$unit.service" ]; then
    HAD_UNIT=1
    info "Stopping and removing $unit.service"
    $PRIV systemctl stop "$unit" 2>/dev/null || true
    $PRIV systemctl disable "$unit" 2>/dev/null || true
    $PRIV rm -f "/etc/systemd/system/$unit.service"
  fi
done
# A systemctl failure here (e.g. no systemd on this box) must not abort the
# rest of the cleanup below — the symlink/repo removal still needs to run.
[ "$HAD_UNIT" = "1" ] && { $PRIV systemctl daemon-reload || warn "systemctl daemon-reload failed — you may need to do that manually."; }

# ──────────── Extension symlink ────────────

EXT_DIR="$ST_PATH/data/$ST_USER/extensions/mp-extension"
if [ -L "$EXT_DIR" ] || [ -e "$EXT_DIR" ]; then
  info "Removing extension link at $EXT_DIR"
  rm -rf "$EXT_DIR"
fi

# ──────────── The repo itself ────────────

echo
if ask_yn "Also delete the checkout at $INSTALL_DIR (repo, certs, config.local.js, node_modules)? This cannot be undone." n; then
  rm -rf "$INSTALL_DIR"
  info "Deleted $INSTALL_DIR"
else
  info "Left $INSTALL_DIR in place — only the running services/link were removed."
fi

echo
info "Done. SillyTavern itself, Node, and Chromium were left untouched."
