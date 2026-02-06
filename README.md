# SillyTavern Multiplayer

Unofficial extension that adds multiplayer to [SillyTavern](https://github.com/SillyTavern/SillyTavern). Let your friends join your RP sessions through a browser - they see the chat, send messages as their characters, and interact with the AI together in real time.

Based on [LiamDobbelaere/sillytavern-mp](https://github.com/LiamDobbelaere/sillytavern-mp).

## What's different in this fork

- **WebSocket** - instant message delivery instead of HTTP polling, near-zero latency
- **Swipes** - navigate between alternative AI responses from the web client
- **Regenerate** - Ctrl+Enter to regenerate the last AI response
- **Edit messages** - click ✎ on any message to edit it inline
- **Online presence** - see who's connected in real time
- **Typing indicators** - see when someone is typing
- **Visual feedback** - toast notifications for swipes, regeneration, edits
- **Markdown rendering** - proper formatting with bold, italic, dialogue highlighting
- **Persistent name** - character name saves across page refreshes

## How it works

1. The **ST extension** runs inside SillyTavern on the host's machine
2. The **server** relays chat history and commands between ST and web clients via WebSocket
3. The **web client** is a lightweight frontend where players read the chat and send messages

When a player sends a message, the extension mimics user actions — it selects the matching persona, types the message, and triggers AI generation.

## Setup

### 1. Install the extension

Clone the repo into your into your SillyTavern extensions directory:
```
SillyTavern/data/default-user/extensions/
```
Make sure `index.js` and `manifest.json` are in the root of the extension folder.

### 2. Move folders

Move or copy the silly-tavern-mp-extension and server folders into your root extension folder mentioned above so that the structure looks like this:
```
extensions/
  silly-tavern-mp-extension/
  server/
```

### 3. Start the server

```bash
cd server
npm install
node index.js
```
Or just double-click `start.bat`.

The server runs on port 3000 by default.

### 4. Configure

If the server runs on a different machine, update `const TARGET_URL` in the extension's `index.js`:
```js
const TARGET_URL = 'http://your-server-address:3000';
```

### 5. Connect

- Open `http://localhost:3000` (or your server's address) in a browser
- Enter your character name
- Start sending messages

## Exposing to the internet

For friends to connect remotely, you need to expose the server. Options:
- **Radmin VPN / Hamachi** — create a virtual LAN, friends connect to your local IP within the network. Easiest option, no configuration needed
- **Port forwarding** — forward port 3000 on your router
- **Cloudflare Tunnel** / **ngrok** — no port forwarding needed
- **VPS** — host the server on a cheap VPS

Your SillyTavern instance stays local — only the server needs to be reachable.

## Controls

| Action | Shortcut |
|---|---|
| Send message | Enter |
| Regenerate | Ctrl+Enter |
| Swipe left/right | ◂ ▸ buttons on last AI message |
| Edit message | ✎ button (hover over message) |
| Save edit | Ctrl+Enter in edit mode |
| Cancel edit | Escape |