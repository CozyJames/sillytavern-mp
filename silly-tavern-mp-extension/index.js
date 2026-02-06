// SillyTavern Multiplayer Extension (WebSocket version)
import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

const TARGET_URL = 'http://localhost:3000';

let socket = null;
let lastChatStr = '';
let commandQueue = [];
let processing = false;

// ──────────── Boot: load socket.io client dynamically ────────────

function boot() {
  const script = document.createElement('script');
  script.src = TARGET_URL + '/socket.io/socket.io.js';
  script.onload = () => {
    console.log('[MP] socket.io client loaded');
    connectSocket();
  };
  script.onerror = () => {
    console.warn('[MP] Failed to load socket.io, falling back to HTTP polling');
    startHttpPolling();
  };
  document.head.appendChild(script);
}

// ──────────── Socket.IO connection ────────────

function connectSocket() {
  // io() is now globally available from the loaded script
  socket = io(TARGET_URL, {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on('connect', () => {
    console.log('[MP] WebSocket connected');
  });

  socket.on('disconnect', () => {
    console.warn('[MP] WebSocket disconnected');
  });

  // ── Receive commands from web clients instantly ──
  socket.on('command', (cmd) => {
    console.log('[MP] Received command:', cmd.type || 'message');
    queueCommand(cmd);
  });

  // Start pushing chat history
  setInterval(pushChatHistory, 1500);
}

// ──────────── Push chat history to server ────────────

function pushChatHistory() {
  const chat = getContext().chat;
  const str = JSON.stringify(chat);
  if (str === lastChatStr) return;
  lastChatStr = str;

  if (socket && socket.connected) {
    socket.emit('chat-update', chat);
  } else {
    // HTTP fallback
    fetch(TARGET_URL + '/set-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: str,
    }).catch(e => console.error('[MP] HTTP push failed:', e));
  }
}

// ──────────── Command processing ────────────

function queueCommand(cmd) {
  commandQueue.push(cmd);
  if (!processing) processNext();
}

function processNext() {
  if (commandQueue.length === 0) { processing = false; return; }
  processing = true;
  const cmd = commandQueue.shift();
  executeCommand(cmd);
  const delay = cmd.type === 'message' ? 10000 : 1500;
  setTimeout(processNext, delay);
}

function executeCommand(cmd) {
  if (!cmd.type) {
    sendMessageAs(cmd.name, cmd.message);
    return;
  }
  switch (cmd.type) {
    case 'message':  sendMessageAs(cmd.name, cmd.message); break;
    case 'swipe':    handleSwipe(cmd.direction); break;
    case 'regenerate': handleRegenerate(); break;
    case 'edit':     handleEdit(cmd.index, cmd.text); break;
    default: console.warn('[MP] Unknown command:', cmd.type);
  }
}

// ──────────── Send message as character ────────────

function sendMessageAs(name, message) {
  console.log('[MP] Sending as:', name);
  $("#user_avatar_block .avatar-container").each((k, v) => {
    if (v.innerText.toLowerCase().includes(name.toLowerCase())) v.click();
  });
  $("#send_textarea").val(message);
  setTimeout(() => getContext().generate(), 1000);
}

// ──────────── Swipe ────────────

function handleSwipe(direction) {
  console.log('[MP] Swipe:', direction);
  const lastMes = $('#chat .mes').last();
  if (!lastMes.length) { console.warn('[MP] No messages'); return; }

  const cls = direction === 'left' ? '.swipe_left' : '.swipe_right';
  const btn = lastMes.find(cls);
  if (btn.length) {
    btn.trigger('click');
    console.log('[MP] Swipe triggered:', cls);
  } else {
    console.warn('[MP] Swipe button not found:', cls);
    console.warn('[MP] Available:', lastMes.find('[class*=swipe]').map((i,e) => e.className).get());
  }

  // Force re-sync chat after swipe
  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 2000);
}

// ──────────── Regenerate ────────────

function handleRegenerate() {
  console.log('[MP] Regenerating');
  const selectors = ['#option_regenerate', '.option_regenerate', '#regenerate_but', '.regenerate_but'];
  for (const sel of selectors) {
    const btn = $(sel);
    if (btn.length && btn.is(':visible')) {
      btn.trigger('click');
      console.log('[MP] Regen via:', sel);
      setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 3000);
      return;
    }
  }
  // Fallback: swipe right
  console.log('[MP] No regen button, using swipe right');
  handleSwipe('right');
}

// ──────────── Edit ────────────

function handleEdit(index, newText) {
  console.log('[MP] Edit index:', index);
  const context = getContext();
  const chat = context.chat;
  if (index < 0 || index >= chat.length) return;

  const mesBlock = $(`#chat .mes[mesid="${index}"]`);
  if (mesBlock.length) {
    const editBtn = mesBlock.find('.mes_edit');
    if (editBtn.length) {
      editBtn.trigger('click');
      setTimeout(() => {
        const ta = mesBlock.find('.edit_textarea');
        if (ta.length) {
          ta.val(newText);
          mesBlock.find('.mes_edit_done').trigger('click');
          console.log('[MP] Edit saved');
          setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 500);
        }
      }, 300);
      return;
    }
  }

  // Fallback: direct edit
  chat[index].mes = newText;
  if (chat[index].swipes && chat[index].swipe_id !== undefined) {
    chat[index].swipes[chat[index].swipe_id] = newText;
  }
  context.saveChat();
  lastChatStr = '';
  pushChatHistory();
}

// ──────────── HTTP fallback (if socket.io fails to load) ────────────

function startHttpPolling() {
  console.log('[MP] Starting HTTP polling fallback');
  setInterval(() => {
    pushChatHistory();
    fetch(TARGET_URL + '/queued-messages')
      .then(r => r.json())
      .then(data => {
        if (data && data.length) data.forEach(cmd => queueCommand(cmd));
      })
      .catch(() => {});
  }, 2000);
}

// ──────────── Init ────────────

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
  // Force push on new messages for faster sync
  lastChatStr = '';
  pushChatHistory();
});

boot();
