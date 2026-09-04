# Keeper

A headless Chromium tab (via [Puppeteer](https://pptr.dev/)) that keeps a SillyTavern session open 24/7, so the [extension](../extension) stays connected without a real browser open on your desktop.

## Table of contents

- [Why it exists](#why-it-exists)
- [How it works](#how-it-works)
- [Automatic reload on data changes](#automatic-reload-on-data-changes)
  - [What's watched](#whats-watched)
  - [What's deliberately excluded, and why](#whats-deliberately-excluded-and-why)
- [Configuration](#configuration)
- [Running it](#running-it)
- [Troubleshooting](#troubleshooting)

## Why it exists

SillyTavern's extension API only runs inside a real browser tab that has the tavern page open — there's no headless/API-only mode for it. If you close your browser, the [mp-extension](../extension) goes offline and players can't do anything. Keeper solves this by being that browser tab, running unattended on the same machine as SillyTavern (typically your VPS), controlled by [`deploy/install.sh`](../deploy/install.sh) as a systemd service (`tavern-keeper`).

## How it works

`keeper.js` launches headless Chromium, opens `ST_URL`, and waits for it to load. That's it — from SillyTavern's point of view it's just another logged-in browser tab, indistinguishable from a real one, running the mp-extension like any other tab would.

If the browser process itself crashes or disconnects, keeper exits and lets systemd (`Restart=on-failure`) bring it back.

## Automatic reload on data changes

SillyTavern has **no live sync between separate browser tabs/sessions**. If you manage your tavern through your own SSH tunnel (`ssh -L 8000:127.0.0.1:8000 ...`), that's a different browser session from keeper's — a new preset, character, or world you add there won't show up for the mp-extension/web client until keeper's tab reloads.

To avoid relying on a blind timer, set `ST_DATA_PATH` (see [Configuration](#configuration)) and keeper watches that folder with [chokidar](https://github.com/paulmillr/chokidar) and reloads its tab automatically, debounced ~3 seconds after the last change — so a preset you just saved shows up in a few seconds, not up to 30 minutes later.

### What's watched

Folder names come straight from SillyTavern's own [`src/constants.js`](https://github.com/SillyTavern/SillyTavern/blob/release/src/constants.js) (`USER_DIRECTORY_TEMPLATE`), so they stay correct even though the on-disk names don't always match the in-app labels:

| Watched path (relative to `ST_DATA_PATH`) | What it holds |
|---|---|
| `settings.json` | Most tavern-wide settings, including the persona list |
| `characters/` | Character cards |
| `worlds/` | World info / lorebooks |
| `groups/` | Group chat definitions |
| `OpenAI Settings/`, `NovelAI Settings/`, `KoboldAI Settings/`, `TextGen Settings/` | Per-API presets |
| `instruct/`, `context/`, `QuickReplies/`, `sysprompt/`, `reasoning/` | Other preset types |

### What's deliberately excluded, and why

**`chats/` and `group chats/` are never watched.** SillyTavern writes to those on every single message during normal play. Watching them would reload keeper's tab constantly during an active session — the opposite of what you want, since a reload briefly drops the mp-extension's connection. `thumbnails*` is excluded too — it's a regenerated image cache, not user-authored data.

If nothing under `ST_DATA_PATH` changes, keeper still reloads on a 30-minute timer as a dumb fallback (e.g. in case the tab wedges silently). You can always force one immediately with `sudo systemctl restart tavern-keeper`.

## Configuration

Environment variables (set as `Environment=` lines in the systemd unit, or exported before running `node keeper.js` directly):

| Variable | Default | Purpose |
|---|---|---|
| `ST_URL` | `http://127.0.0.1:8000` | Address keeper opens in its headless tab |
| `CHROME_PATH` | `/usr/bin/chromium-browser` | Path to the Chromium/Chrome binary |
| `ST_DATA_PATH` | *(unset)* | Path to your SillyTavern user's data folder, e.g. `/root/SillyTavern/data/default-user`. Enables [automatic reload on data changes](#automatic-reload-on-data-changes); without it, keeper only reloads on the 30-minute timer |

`deploy/install.sh` sets `ST_URL`, `CHROME_PATH`, and `ST_DATA_PATH` for you when you choose to install the keeper. To change any of them afterwards without re-running the installer, see [`../deploy/README.md`](../deploy/README.md#кипер-что-это-и-как-понять-что-он-живой).

## Running it

Normally you don't run this directly — the installer sets it up as the `tavern-keeper` systemd service. To run it by hand (e.g. for local testing):
```bash
cd keeper
npm install
ST_URL=http://127.0.0.1:8000 CHROME_PATH=/usr/bin/chromium node keeper.js
```

## Troubleshooting

Day-to-day commands (restart, logs, fixing a broken `ST_DATA_PATH`, common errors after `git pull`) live in [`../deploy/README.md`](../deploy/README.md) — that's the doc to reach for when something's actually broken.
