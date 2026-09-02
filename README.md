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

If the server runs on a different machine, update `const TARGET_URL` in the extension's `index.js`:
```js
const TARGET_URL = 'http://your-server-address:3000';
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

Your SillyTavern instance stays local — only the server needs to be reachable. Note that avatars are loaded directly from your SillyTavern instance's origin, so if you only tunnel the multiplayer server, avatar images won't load for remote players.

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
