# SillyTavern Multiplayer — extension

The SillyTavern-side half of this project. Runs inside SillyTavern's own
browser tab and connects to the relay server (see `../server`) over
WebSocket, driving the tavern via its own STscript slash-commands
(`/persona-set`, `/send`, `/swipe`, `/regenerate`, `/cut`, `/go`,
`/newchat`, `/continue`, `/model`, `/preset`, ...) rather than simulating
DOM clicks.

See the root [README.md](../README.md) for setup and how this fits
together with `server/` and `keeper/`.

## Configuration

Copy `config.local.example.js` to `config.local.js` (gitignored) and set
`TARGET_URL`/`AUTH_TOKEN` there — see the root README's "Configure"
section.
