const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB for large chat histories
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT');
  next();
});
app.use(express.static('public'));

// ──────────── State ────────────
let chatHistory = [];
const onlineUsers = new Map(); // name → timestamp
const PRESENCE_TIMEOUT = 12_000;

// ──────────── Socket.IO ────────────
io.on('connection', (socket) => {
  console.log(`[WS] Connected: ${socket.id}`);

  // Send current chat history to newly connected client
  socket.emit('chat-update', chatHistory);

  // Broadcast current online list
  broadcastOnline();

  // ── Chat history from ST extension ──
  socket.on('chat-update', (data) => {
    chatHistory = data;
    // Broadcast to everyone EXCEPT the sender (extension)
    socket.broadcast.emit('chat-update', chatHistory);
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
  console.log('Server running on port 3000 (HTTP + WebSocket)');
});
