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
  const ctx = getContext();
  console.log('[MP] Extension booting. executeSlashCommandsWithOptions available:', typeof ctx.executeSlashCommandsWithOptions === 'function');

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

// Grab ST's own rendered HTML for each message — this already has
// markdown/HTML formatting, macros ({{getvar::x}}, {{char}}, etc.) resolved,
// and any display Regex scripts applied, exactly as SillyTavern shows them.
function getEnrichedChat() {
  const chat = getContext().chat;
  return chat.map((msg, i) => {
    const mesBlock = document.querySelector(`#chat .mes[mesid="${i}"] .mes_text`);
    return {
      ...msg,
      renderedHtml: mesBlock ? mesBlock.innerHTML : null,
    };
  });
}

function pushChatHistory() {
  const enriched = getEnrichedChat();
  const str = JSON.stringify(enriched);
  if (str === lastChatStr) return;
  lastChatStr = str;

  if (socket && socket.connected) {
    socket.emit('chat-update', enriched);
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

// ──────────── Send message as character (via STscript) ────────────

async function sendMessageAs(name, message) {
  console.log('[MP] Sending as:', name);
  const ctx = getContext();

  const safeName = stEscape(name);
  const safeMessage = stEscape(message);

  // NOTE: /persona and /send take raw text as their argument — they do NOT
  // strip surrounding quotes like a shell would. Wrapping in "" just puts
  // literal quote characters into the message. Only pipes need escaping,
  // since | is the STscript command separator.
  const script = `/persona ${safeName} | /send ${safeMessage} | /trigger`;

  try {
    await ctx.executeSlashCommandsWithOptions(script);
    console.log('[MP] Sent via STscript');
  } catch (e) {
    console.error('[MP] STscript send failed:', e);
    // Fallback to old DOM method
    sendMessageAsLegacy(name, message);
  }
}

// Escape characters that would break STscript command chaining
function stEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

function sendMessageAsLegacy(name, message) {
  console.log('[MP] Falling back to legacy DOM method');
  $("#user_avatar_block .avatar-container").each((k, v) => {
    if (v.innerText.toLowerCase().includes(name.toLowerCase())) v.click();
  });
  $("#send_textarea").val(message);
  setTimeout(() => getContext().generate(), 1000);
}

// ──────────── Swipe ────────────

async function handleSwipe(direction) {
  console.log('[MP] Swipe:', direction);

  if (direction === 'right') {
    // Right swipe generates a new one — use official STscript command
    const ctx = getContext();
    try {
      await ctx.executeSlashCommandsWithOptions('/swipe');
      console.log('[MP] Swiped right via STscript');
      setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 2000);
      return;
    } catch (e) {
      console.warn('[MP] /swipe STscript failed, trying DOM fallback:', e);
    }
  }

  // Left swipe (navigate back) or fallback: DOM click
  const lastMes = $('#chat .mes').last();
  if (!lastMes.length) { console.warn('[MP] No messages'); return; }

  const cls = direction === 'left' ? '.swipe_left' : '.swipe_right';
  const btn = lastMes.find(cls);
  if (btn.length) {
    btn.trigger('click');
    console.log('[MP] Swipe triggered via DOM:', cls);
  } else {
    console.warn('[MP] Swipe button not found:', cls);
    console.warn('[MP] Available:', lastMes.find('[class*=swipe]').map((i,e) => e.className).get());
  }

  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 2000);
}

// ──────────── Regenerate (via STscript) ────────────

async function handleRegenerate() {
  console.log('[MP] Regenerating');
  const ctx = getContext();

  try {
    await ctx.executeSlashCommandsWithOptions('/regenerate');
    console.log('[MP] Regenerated via STscript');
    setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 3000);
    return;
  } catch (e) {
    console.warn('[MP] /regenerate STscript failed, trying DOM fallback:', e);
  }

  // Fallback: DOM click
  const selectors = ['#option_regenerate', '.option_regenerate', '#regenerate_but', '.regenerate_but'];
  for (const sel of selectors) {
    const btn = $(sel);
    if (btn.length) {
      btn[0].click();
      console.log('[MP] Regen via DOM:', sel);
      setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 3000);
      return;
    }
  }

  console.warn('[MP] All regenerate methods failed');
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
  // Retry shortly after — DOM render can lag slightly behind this event
  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 500);
});

// Fires once ST has actually painted the message into the DOM —
// this is when .mes_text has the final rendered HTML available
if (event_types.CHARACTER_MESSAGE_RENDERED) {
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    lastChatStr = '';
    pushChatHistory();
  });
}
if (event_types.USER_MESSAGE_RENDERED) {
  eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
    lastChatStr = '';
    pushChatHistory();
  });
}

boot();
