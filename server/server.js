const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();

// ──────────── Optional TLS ────────────
// Set MP_TLS_CERT / MP_TLS_KEY (paths to a cert + key, self-signed is fine)
// to serve over HTTPS/WSS instead of plain HTTP/WS.
const TLS_CERT = process.env.MP_TLS_CERT;
const TLS_KEY = process.env.MP_TLS_KEY;
const useTls = Boolean(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
  : http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB for large chat histories
});

// ──────────── Optional login (cookie session, not the browser's native Basic Auth popup) ────────────
// Set MP_AUTH_USER / MP_AUTH_PASS to require signing in via /login for anyone
// connecting from outside the box. Connections from localhost are always
// exempt (useful if the server and the browser viewing it are genuinely on
// the same machine), but note that's usually NOT true for the ST extension:
// it runs inside whatever browser is displaying the tavern, which is
// normally a remote machine (the host's own laptop) even when the tavern
// and this relay both run on the same VPS, so it needs its own way in.
// Set MP_EXTENSION_TOKEN to a shared secret and put the same value in the
// extension's AUTH_TOKEN constant to let it connect without a browser login.
const AUTH_USER = process.env.MP_AUTH_USER;
const AUTH_PASS = process.env.MP_AUTH_PASS;
const authEnabled = Boolean(AUTH_USER && AUTH_PASS);
const EXTENSION_TOKEN = process.env.MP_EXTENSION_TOKEN;
const COOKIE_NAME = 'mp_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const sessions = new Set(); // valid session tokens; cleared on restart

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hasValidExtensionToken(token) {
  return Boolean(EXTENSION_TOKEN && token && timingSafeStringEqual(token, EXTENSION_TOKEN));
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function hasValidSession(cookieHeader) {
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  return Boolean(token && sessions.has(token));
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT');
  next();
});

if (authEnabled) {
  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
  });

  app.post('/login', (req, res) => {
    const { user, pass } = req.body || {};
    if (timingSafeStringEqual(user || '', AUTH_USER) && timingSafeStringEqual(pass || '', AUTH_PASS)) {
      const token = crypto.randomBytes(32).toString('hex');
      sessions.add(token);
      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: useTls,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE_MS,
      });
      return res.redirect('/');
    }
    res.redirect('/login?error=1');
  });

  app.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) sessions.delete(token);
    res.clearCookie(COOKIE_NAME);
    res.redirect('/login');
  });

  app.use((req, res, next) => {
    if (isLoopback(req.socket.remoteAddress)) return next();
    if (req.path === '/login') return next();
    if (hasValidExtensionToken(req.headers['x-mp-token'] || req.query.mp_token)) return next();
    if (hasValidSession(req.headers.cookie)) return next();
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      return res.redirect('/login');
    }
    res.status(401).json({ error: 'unauthorized' });
  });

  io.use((socket, next) => {
    if (isLoopback(socket.handshake.address)) return next();
    if (hasValidExtensionToken(socket.handshake.auth?.token)) return next();
    if (hasValidSession(socket.handshake.headers.cookie)) return next();
    next(new Error('unauthorized'));
  });
} else {
  console.warn('[MP] MP_AUTH_USER / MP_AUTH_PASS not set. The server has NO authentication. Do not expose it to the internet like this.');
}

// ──────────── Avatar proxy ────────────
// The extension no longer sends absolute avatar URLs (they'd point at
// whatever origin its own browser used to reach ST, e.g. localhost:8000
// through an SSH tunnel, which is meaningless, and often unreachable/
// blocked by the viewer's browser, for anyone else). Instead it sends ST's
// own relative /thumbnail path, and we fetch it server-side: this server
// and ST normally run on the same box, so this is a plain loopback request
// with none of the browser-side cross-origin/private-network restrictions.
const ST_LOCAL_URL = process.env.ST_LOCAL_URL || 'http://127.0.0.1:8000';

app.get('/thumbnail', async (req, res) => {
  try {
    const upstream = new URL('/thumbnail', ST_LOCAL_URL);
    upstream.search = new URLSearchParams(req.query).toString();
    const r = await fetch(upstream);
    if (!r.ok) return res.sendStatus(r.status);
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    console.error('[MP] Avatar proxy failed:', e.message);
    res.sendStatus(502);
  }
});

app.use(express.static('public'));

// ──────────── State ────────────
let chatHistory = [];
let sessionInfo = null; // characters, personas, current chat/character, tokens
let generationStatus = { generating: false, characterName: null };
const onlineUsers = new Map(); // name → timestamp
const PRESENCE_TIMEOUT = 12_000;

// ──────────── Turn rounds ────────────
// The group always plays bot / player / bot / player. There's no "start
// round" button or GM role: a round opens itself the moment any connected
// player acts (sends a message or explicitly skips), against whoever else
// is online right then. Each individual action still posts to the tavern
// right away (so messages appear one by one as usual) but doesn't trigger
// the AI: only the very last player to respond does, so everyone's action
// lands in the prompt before the AI replies once. A player who skips just
// contributes nothing; if literally everyone skips, nothing is sent at all.
// A message sent with `force: true` closes the round immediately instead,
// for a player who doesn't want to wait on the rest of the group. Deleting
// your own message before the round closes un-counts your turn too, so you
// can't write-then-delete to burn your slot without actually weighing in.
const playerSocketIds = new Set(); // sockets that have sent at least one heartbeat (real web clients)
let round = null; // { expectedIds: Set<socketId>, responded: Set<socketId>, hadAnyMessage: bool }

function socketName(id) {
  return io.sockets.sockets.get(id)?.data?.name || null;
}

function broadcastRoundStatus() {
  if (!round) { io.emit('round-status', null); return; }
  const waitingFor = [...round.expectedIds]
    .filter((id) => !round.responded.has(id))
    .map(socketName)
    .filter(Boolean);
  io.emit('round-status', { waitingFor, total: round.expectedIds.size });
}

function sendToHost(cmd) {
  if (hostSocketId) io.to(hostSocketId).emit('command', cmd);
  else io.emit('command', cmd); // no host yet, broadcast fallback, same as generic command routing
}

// Handles the two turn-taking commands ('message' and 'skip-turn'). Every
// other command type bypasses this and goes straight to the host as before.
function handleTurnAction(socket, cmd, type) {
  if (!round) round = { expectedIds: new Set(playerSocketIds), responded: new Set(), hadAnyMessage: false, contributions: new Map() };

  round.expectedIds.add(socket.id); // a late joiner who acts still counts as responded, not left dangling
  round.responded.add(socket.id);
  // A forced message (player explicitly doesn't want to wait for the rest)
  // closes the round right away, same as if everyone else had responded.
  const isLast = cmd.force || [...round.expectedIds].every((id) => round.responded.has(id));

  if (type === 'message') {
    round.hadAnyMessage = true;
    // Remembered so a delete of this exact message (see reopenRoundIfDeleted)
    // can undo the "responded" credit it earned, otherwise a player could
    // write, delete, and effectively skip while still counting as having
    // acted, letting the round close without them ever really weighing in.
    round.contributions.set(socket.id, { name: cmd.name, message: cmd.message });
    sendToHost({ type: 'message', personaId: cmd.personaId, message: cmd.message, name: cmd.name, noTrigger: !isLast });
  }

  if (isLast) {
    // The round is complete. If the closing action was a skip but someone
    // else already sent a real message this round, the AI still needs to be
    // asked to respond to those: fire the trigger on its own.
    if (type !== 'message' && round.hadAnyMessage) sendToHost({ type: 'trigger-only' });
    round = null;
  }
  broadcastRoundStatus();
}

// A message deleted while the round it was sent in is still open shouldn't
// keep counting as that player's turn, otherwise writing something, deleting
// it, and having someone else act is indistinguishable from actually skipping,
// except the round closes without ever really waiting on them. Matches by
// name+text against what was recorded when they sent it, since chat indices
// shift under deletes and the server doesn't have a more stable message id.
function reopenRoundIfDeleted(index) {
  if (!round || typeof index !== 'number') return;
  const deleted = chatHistory[index];
  if (!deleted) return;
  for (const [id, contribution] of round.contributions) {
    if (!round.responded.has(id)) continue;
    if (contribution.name === deleted.name && contribution.message === deleted.mes) {
      round.responded.delete(id);
      round.contributions.delete(id);
      broadcastRoundStatus();
      return;
    }
  }
}

// Single-host arbitration. The extension loads in EVERY SillyTavern tab (it's
// in ST's shared extensions dir), so the keeper's headless tab and the user's
// own tunnel'd tab can both be running it. If more than one acted as the
// relay's source of truth they'd fight: different active character/chat per
// tab, commands landing in the wrong one, state flip-flopping. So exactly one
// registered extension is the host at a time; every other is told to stand
// down (see the extension's 'extension-role' handling). The keeper registers
// with role 'keeper' and gets priority as the stable, always-on host.
let hostSocketId = null;
const extensions = new Map(); // socket.id -> role ('keeper' | 'tab')

function pickHost() {
  // Prefer a keeper over a transient human tab; otherwise first one wins.
  let firstTab = null;
  for (const [id, role] of extensions) {
    if (role === 'keeper') return id;
    if (firstTab === null) firstTab = id;
  }
  return firstTab;
}

function reassignHost() {
  const next = pickHost();
  if (next === hostSocketId) return;
  const prev = hostSocketId;
  hostSocketId = next;
  if (prev && io.sockets.sockets.get(prev)) io.to(prev).emit('extension-role', { host: false });
  if (hostSocketId) io.to(hostSocketId).emit('extension-role', { host: true });
  console.log('[WS] Host is now:', hostSocketId || '(none)');
}

// An extension that pushes state without having explicitly registered (an
// older extension build) is registered on the fly as a plain tab, so a
// half-upgraded deploy still elects a host instead of going dead.
function ensureRegistered(socket) {
  if (!extensions.has(socket.id)) {
    extensions.set(socket.id, 'tab');
    reassignHost();
  }
}

// The extension always pushes the FULL chat history (that traffic stays
// local/same-box, it's cheap), but re-broadcasting all of it to every
// player's browser on every single change, especially the rapid-fire
// updates during streaming generation, means resending an ever-growing
// payload (a long-running RP chat can be hundreds of messages) many times
// a minute to everyone watching. Players only ever need to actually SEE
// the tail live; older messages are fetched on demand (see 'load-older').
const LIVE_WINDOW = 60;

function chatWindow() {
  const offset = Math.max(0, chatHistory.length - LIVE_WINDOW);
  return { messages: chatHistory.slice(offset), offset, total: chatHistory.length };
}

// ──────────── Socket.IO ────────────
io.on('connection', (socket) => {
  console.log(`[WS] Connected: ${socket.id}`);

  // Send current state to newly connected client
  socket.emit('chat-update', chatWindow());
  if (sessionInfo) socket.emit('session-info', sessionInfo);
  socket.emit('generation-status', generationStatus);

  // Broadcast current online list
  broadcastOnline();

  // ── An extension identifying itself and its role (keeper vs plain tab) ──
  socket.on('register-extension', ({ role } = {}) => {
    extensions.set(socket.id, role === 'keeper' ? 'keeper' : 'tab');
    console.log(`[WS] Extension registered: ${socket.id} (${extensions.get(socket.id)})`);
    reassignHost();
  });

  // ── Chat history from ST extension (only the host's is authoritative) ──
  socket.on('chat-update', (data) => {
    ensureRegistered(socket);
    if (socket.id !== hostSocketId) return; // ignore non-host tabs
    chatHistory = data;
    // Broadcast to everyone EXCEPT the sender (extension)
    socket.broadcast.emit('chat-update', chatWindow());
  });

  // ── Web client asking for older messages than it currently has ──
  socket.on('load-older', ({ before }, ack) => {
    if (typeof ack !== 'function') return;
    const end = Math.max(0, Math.min(before ?? 0, chatHistory.length));
    const start = Math.max(0, end - LIVE_WINDOW);
    ack({ messages: chatHistory.slice(start, end), offset: start });
  });

  // ── Session info (characters/personas/current chat/tokens) from ST extension ──
  socket.on('session-info', (data) => {
    ensureRegistered(socket);
    if (socket.id !== hostSocketId) return;
    sessionInfo = data;
    socket.broadcast.emit('session-info', sessionInfo);
  });

  // ── AI generation status from ST extension, visible to every player ──
  socket.on('generation-status', (data) => {
    if (socket.id !== hostSocketId) return;
    generationStatus = data;
    socket.broadcast.emit('generation-status', generationStatus);
  });

  // ── Errors relayed from ST's own toast notifications ──
  socket.on('error', (data) => {
    socket.broadcast.emit('error', data);
  });

  // ── Past chats list, requested by a web client, gathered by the extension ──
  socket.on('chats-list', (data) => {
    socket.broadcast.emit('chats-list', data);
  });

  // ── Model / preset lists, requested by a web client, gathered by the extension ──
  socket.on('models-list', (data) => {
    socket.broadcast.emit('models-list', data);
  });
  socket.on('presets-list', (data) => {
    socket.broadcast.emit('presets-list', data);
  });

  // ── Command from web client → forward to ST extension ──
  socket.on('command', (cmd) => {
    const type = cmd.type || 'message';
    console.log('[WS] Command:', type);

    // 'message' and 'skip-turn' go through turn-round coordination instead
    // of straight to the host, see handleTurnAction.
    if (type === 'message' || type === 'skip-turn') {
      handleTurnAction(socket, cmd, type);
      socket.emit('command-ack', { type });
      return;
    }

    if (type === 'delete') reopenRoundIfDeleted(cmd.index);

    if (hostSocketId) {
      io.to(hostSocketId).emit('command', cmd);
    } else {
      // No host elected yet (fresh server start, extension reconnecting):
      // fall back to broadcasting so the command still has a chance of
      // arriving. Non-host extensions ignore commands, so this is safe.
      io.emit('command', cmd);
    }
    // Ack back to sender with the command type
    socket.emit('command-ack', { type });
  });

  // ── Heartbeat ──
  socket.on('heartbeat', ({ name }) => {
    if (!name) return;
    // A client's resolved name can change after connecting (persona list
    // loads after the first heartbeat as "Guest", or they switch persona):
    // drop the stale entry instead of leaving it to linger until it times out.
    if (socket.data.name && socket.data.name !== name) {
      onlineUsers.delete(socket.data.name);
    }
    socket.data.name = name;
    onlineUsers.set(name, Date.now());
    playerSocketIds.add(socket.id);
    broadcastOnline();
  });

  // ── Typing ──
  socket.on('typing', ({ name }) => {
    if (!name) return;
    socket.broadcast.emit('user-typing', { name });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[WS] Disconnected: ${socket.id}`);
    if (extensions.has(socket.id)) {
      extensions.delete(socket.id);
      if (socket.id === hostSocketId) hostSocketId = null;
      reassignHost(); // promote another extension (a waiting tab) if any
    }
    if (socket.data.name) {
      onlineUsers.delete(socket.data.name);
      broadcastOnline();
    }
    playerSocketIds.delete(socket.id);
    // Someone leaving mid-round shouldn't leave everyone else waiting on
    // them forever, drop them from this round too, which may complete it.
    if (round && round.expectedIds.has(socket.id) && !round.responded.has(socket.id)) {
      round.expectedIds.delete(socket.id);
      const isLast = [...round.expectedIds].every((id) => round.responded.has(id));
      if (isLast) {
        if (round.hadAnyMessage) sendToHost({ type: 'trigger-only' });
        round = null;
      }
      broadcastRoundStatus();
    }
  });
});

function broadcastOnline() {
  const now = Date.now();
  for (const [name, ts] of onlineUsers) {
    if (now - ts > PRESENCE_TIMEOUT) onlineUsers.delete(name);
  }
  io.emit('online-users', [...onlineUsers.keys()]);
}

// Prune stale users periodically
setInterval(broadcastOnline, PRESENCE_TIMEOUT);

// ──────────── Start ────────────
server.listen(3000, '0.0.0.0', () => {
  console.log(`Server running on port 3000 (${useTls ? 'HTTPS' : 'HTTP'} + WebSocket, auth ${authEnabled ? 'ON' : 'OFF'})`);
});
