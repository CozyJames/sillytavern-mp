# SillyTavern Multiplayer

Unofficial extension that adds multiplayer to [SillyTavern](https://github.com/SillyTavern/SillyTavern). Let your friends join your RP sessions through a browser - they see the chat, send messages as their characters, and interact with the AI together in real time.

Based on [LiamDobbelaere/sillytavern-mp](https://github.com/LiamDobbelaere/sillytavern-mp).

## What's different in this fork

- **WebSocket** - instant message delivery instead of HTTP polling, near-zero latency
- **STscript-driven** - every action in the tavern (sending, swiping, regenerating, deleting, switching character, new chat) runs through SillyTavern's own slash commands, not simulated clicks
- **Full session control** - switch the active character, start a new chat, or load a past chat, all from the web client
- **Personas from the tavern** - the "send as" list and every avatar (characters and personas) are pulled live from SillyTavern, no manual configuration in the web client
- **Delete & edit messages** - click 🗑 or ✎ on any message
- **Swipes** - navigate between alternative AI responses from the web client
- **Regenerate** - Ctrl+Enter to regenerate the last AI response
- **Generation indicator** - everyone sees when the AI is generating, and which character
- **Thinking blocks** - reasoning-model "thinking" output is shown live, same as in the tavern
- **Context meter** - a live token / max-context counter for the current chat
- **Error toasts** - failures from the tavern (bad API key, connection issues, etc.) show up for everyone
- **Online presence & typing indicators** - see who's connected and who's typing
- **Markdown rendering** - proper formatting with bold, italic, dialogue highlighting
- **Persistent persona** - your selected persona is remembered across page refreshes

## How it works

1. The **extension** runs inside SillyTavern on the host's machine
2. The **server** relays chat history, session state (characters/personas/chats/tokens) and commands between the extension and web clients via WebSocket
3. The **web client** is a lightweight frontend where players manage the session and send messages

When a player sends a message, the extension runs it through SillyTavern's STscript engine (`/persona-set`, `/send`, `/trigger`, `/swipe`, `/regenerate`, `/cut`, `/go`, `/newchat`) — the same commands you'd type into the tavern yourself — so it behaves exactly like a normal user action, no DOM click simulation involved.

## Setup

### Quick install

One-line installers handle cloning, `npm install`, linking the extension into SillyTavern, and (for the remote one) TLS/login/the extension token/systemd services/the headless keeper — asking what they need along the way.

**Everything on your own PC** (no TLS, no login, no keeper — you keep the browser tab open yourself):
```bash
curl -fsSL https://raw.githubusercontent.com/CozyJames/sillytavern-mp/master/deploy/install-local.sh | bash
```

**VPS / remote server** (TLS, login, extension token, systemd services, optional 24/7 headless-browser keeper):
```bash
curl -fsSL https://raw.githubusercontent.com/CozyJames/sillytavern-mp/master/deploy/install.sh | bash
```

Both are safe to re-run (they update the existing checkout rather than re-cloning). To remove everything either one set up: `bash deploy/uninstall.sh` from inside the checkout (never touches SillyTavern, Node, or Chromium — only this project's own services/files, and only the checkout itself if you confirm).

### Manual setup

### 1. Install the extension

Clone the repo into your SillyTavern extensions directory:
```
SillyTavern/data/default-user/extensions/
```
Make sure `index.js` and `manifest.json` are in the root of the extension folder.

### 2. Move folders

Move or copy the `extension` and `server` folders into your root extension folder mentioned above so that the structure looks like this:
```
extensions/
  extension/
  server/
```

### 3. Start the server

```bash
cd server
npm install
node server.js
```
Or just double-click `start.bat`.

The server runs on port 3000 by default.

### 4. Configure

If the server runs on a different machine, copy `extension/config.local.example.js` to `extension/config.local.js` (gitignored — a `git pull` will never touch it or conflict with your values) and set:
```js
export const TARGET_URL = 'http://your-server-address:3000';
export const AUTH_TOKEN = ''; // only needed if MP_EXTENSION_TOKEN is set on the server, see "Securing a publicly exposed server" below
```

Personas, characters and presets are configured once in SillyTavern itself — the web client picks them up automatically, players never need to open the tavern.

### 5. Connect

- Open `http://localhost:3000` (or your server's address) in a browser
- Pick your persona from the "Send as" list
- Start sending messages

## Exposing to the internet

For friends to connect remotely, you need to expose the server. Options:
- **Radmin VPN / Hamachi** — create a virtual LAN, friends connect to your local IP within the network. Easiest option, no configuration needed
- **Port forwarding** — forward port 3000 on your router
- **Cloudflare Tunnel** / **ngrok** — no port forwarding needed
- **VPS** — host the server on a cheap VPS

Your SillyTavern instance stays local — only the server needs to be reachable. The relay server proxies avatar images from SillyTavern itself (via `ST_LOCAL_URL`, default `http://127.0.0.1:8000`) — this works out of the box when SillyTavern and the relay server run on the same machine. If they run on different machines, set `ST_LOCAL_URL` to an address the relay server can actually reach SillyTavern at, or avatars will fall back to initials for everyone.

### Editing SillyTavern's own settings on a VPS (presets, characters, world info, ...)

If SillyTavern runs on a VPS, you're probably already tunneling into it to view/manage it directly:
```bash
ssh -L 8000:127.0.0.1:8000 root@your.server.ip
```
then opening `http://localhost:8000` in your own browser.

That's a genuinely **separate** browser session from the one the mp-extension actually runs in — the `keeper`'s own headless tab (see `keeper/README` — or the root README's Setup section — for what keeper is). SillyTavern has no live sync between separate browser tabs, so anything you change through *your* tunneled tab (a new preset, a new character, ...) won't show up for the mp-extension/web client until keeper's tab happens to reload (every 30 min, or on `systemctl restart tavern-keeper`).

To skip the wait, reach into keeper's own tab directly instead of using a second one:
```bash
ssh -L 9222:127.0.0.1:9222 root@your.server.ip
```
Then in your own Chrome/Chromium (not the tab you use for anything else — this is a separate control channel): go to `chrome://inspect/#devices`, click **Configure...** next to "Discover network targets", add `localhost:9222`, and the running tavern tab should appear under **Remote Target** with an **inspect** link. Click it to open a live DevTools window that mirrors and controls that exact tab — anything you do there (add a preset, edit a character card, ...) is instantly the same session the extension and every player's web client already see. No reload, no restart, nothing to go stale.

**Never** forward or expose port 9222 outside of an SSH tunnel — the DevTools protocol it speaks has no authentication of its own; anyone who can reach it can fully control the browser (and therefore your tavern).

### Securing a publicly exposed server

By default the server has **no authentication and no encryption** — fine on a private LAN/VPN, not fine on the open internet. Set these environment variables before starting it to require a login and serve over HTTPS:

```bash
export MP_AUTH_USER=yourusername
export MP_AUTH_PASS=yourpassword
export MP_EXTENSION_TOKEN=some-long-random-string
export MP_TLS_CERT=/path/to/cert.pem
export MP_TLS_KEY=/path/to/key.pem
node server.js
```

- **Login**: with `MP_AUTH_USER`/`MP_AUTH_PASS` set, anyone connecting from outside the machine is redirected to a login page (`/login`) and gets a session cookie on success. Connections from `localhost` are exempt, but note that's usually *not* what the ST extension is — the extension runs inside whatever browser is displaying the tavern, and that's normally a different machine than the server even when the tavern and this relay server run on the same box (e.g. you're viewing the tavern through an SSH tunnel). For the extension, set `MP_EXTENSION_TOKEN` to a random shared secret here, and put the exact same value in `AUTH_TOKEN` in `extension/config.local.js` (see "Configure" above) — that lets it connect without going through the login page.
- **TLS**: with `MP_TLS_CERT`/`MP_TLS_KEY` set to a certificate + key file, the server switches to HTTPS/WSS. A free self-signed certificate (no domain needed) works fine — generate one with:
  ```bash
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout key.pem -out cert.pem \
    -subj "/CN=sillytavern-mp" \
    -addext "subjectAltName=IP:127.0.0.1,IP:your.server.ip"
  ```
  Browsers will show a "connection is not private" warning on first visit since it's not signed by a public CA — click through it once (same trade-off any self-hosted panel with a self-signed cert has). If the server is TLS-only, remember to point the extension's `TARGET_URL` at `https://` instead of `http://` too.

Both settings work independently — you can enable just the login, just TLS, or both. When both the tavern and this server run on the same VPS (rather than the tavern running on your own PC), set the extension's `TARGET_URL` to the server's public HTTPS address, same as what players use — there's no need to reach it through localhost or an SSH tunnel.

## Controls

| Action | Shortcut |
|---|---|
| Send message | Enter / Send button |
| Regenerate | Ctrl+Enter |
| Swipe left/right | ◂ ▸ buttons on last AI message |
| Edit message | ✎ button (hover over message) |
| Delete message | 🗑 button (hover over message) |
| Save edit | Ctrl+Enter in edit mode |
| Cancel edit | Escape |
| Session panel (character/chats) | ☰ button in the top bar |
