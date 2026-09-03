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
// and this relay both run on the same VPS — so it needs its own way in.
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
  console.warn('[MP] MP_AUTH_USER / MP_AUTH_PASS not set — the server has NO authentication. Do not expose it to the internet like this.');
}

app.use(express.static('public'));

// ──────────── State ────────────
let chatHistory = [];
let sessionInfo = null; // characters, personas, current chat/character, tokens
let generationStatus = { generating: false, characterName: null };
const onlineUsers = new Map(); // name → timestamp
const PRESENCE_TIMEOUT = 12_000;

// ──────────── Socket.IO ────────────
io.on('connection', (socket) => {
  console.log(`[WS] Connected: ${socket.id}`);

  // Send current state to newly connected client
  socket.emit('chat-update', chatHistory);
  if (sessionInfo) socket.emit('session-info', sessionInfo);
  socket.emit('generation-status', generationStatus);

  // Broadcast current online list
  broadcastOnline();

  // ── Chat history from ST extension ──
  socket.on('chat-update', (data) => {
    chatHistory = data;
    // Broadcast to everyone EXCEPT the sender (extension)
    socket.broadcast.emit('chat-update', chatHistory);
  });

  // ── Session info (characters/personas/current chat/tokens) from ST extension ──
  socket.on('session-info', (data) => {
    sessionInfo = data;
    socket.broadcast.emit('session-info', sessionInfo);
  });

  // ── AI generation status from ST extension, visible to every player ──
  socket.on('generation-status', (data) => {
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

  // ── Command from web client → forward to ST extension ──
  socket.on('command', (cmd) => {
    console.log('[WS] Command:', cmd.type || 'message');
    // Broadcast to all (extension will pick it up)
    io.emit('command', cmd);
    // Ack back to sender with the command type
    socket.emit('command-ack', { type: cmd.type || 'message' });
  });

  // ── Heartbeat ──
  socket.on('heartbeat', ({ name }) => {
    if (!name) return;
    // A client's resolved name can change after connecting (persona list
    // loads after the first heartbeat as "Guest", or they switch persona) —
    // drop the stale entry instead of leaving it to linger until it times out.
    if (socket.data.name && socket.data.name !== name) {
      onlineUsers.delete(socket.data.name);
    }
    socket.data.name = name;
    onlineUsers.set(name, Date.now());
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
    if (socket.data.name) {
      onlineUsers.delete(socket.data.name);
      broadcastOnline();
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

// ──────────── HTTP fallback endpoints (backward compat) ────────────
app.post('/set-chat', (req, res) => {
  chatHistory = req.body;
  io.emit('chat-update', chatHistory);
  res.send('ok');
});

app.get('/get-chat', (_req, res) => {
  res.json(chatHistory);
});

// Legacy queue endpoints (no longer primary, but kept for safety)
let queuedMessages = [];
app.post('/queue-message', (req, res) => {
  queuedMessages.push(req.body);
  res.send('ok');
});
app.get('/queued-messages', (_req, res) => {
  res.json(queuedMessages);
  queuedMessages = [];
});

// ──────────── Start ────────────
server.listen(3000, '0.0.0.0', () => {
  console.log(`Server running on port 3000 (${useTls ? 'HTTPS' : 'HTTP'} + WebSocket, auth ${authEnabled ? 'ON' : 'OFF'})`);
});
