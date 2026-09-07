// SillyTavern Multiplayer Extension (WebSocket version)
import { getContext } from "../../../extensions.js";
import { eventSource, event_types, is_send_press } from "../../../../script.js";
import { user_avatar } from "../../../personas.js";

// Deployment-specific values live in config.local.js (gitignored) so a
// `git pull` never conflicts with your local TARGET_URL/AUTH_TOKEN edits.
// Copy config.local.example.js to config.local.js and fill it in there —
// these two are just the fallback for a fresh, unconfigured checkout.
let TARGET_URL = 'http://localhost:3000';
let AUTH_TOKEN = '';
try {
  const cfg = await import('./config.local.js');
  if (cfg.TARGET_URL) TARGET_URL = cfg.TARGET_URL;
  if (cfg.AUTH_TOKEN) AUTH_TOKEN = cfg.AUTH_TOKEN;
} catch (e) {
  console.warn('[MP] No config.local.js found, using defaults:', TARGET_URL);
}

let socket = null;
let lastChatStr = '';
let lastSessionStr = '';
let commandQueue = [];
let processing = false;

// Single-host arbitration. The extension loads in EVERY SillyTavern browser
// tab (it lives in ST's shared extensions dir), so the keeper's headless tab
// AND your own tunnel'd tab can both be running it at once. If more than one
// acted as the relay's source of truth they'd fight — each tab has its own
// active character/chat, so commands land in the wrong tab, generation runs
// as the wrong character, and state flip-flops. The relay server therefore
// designates exactly one extension as the host; every other instance is told
// to stand down and stays fully passive (no pushes, ignores commands). isHost
// is driven entirely by the server's 'extension-role' message below.
let isHost = false;
let roleReceived = false;
// The keeper opens ST with ?mp_host=1 (see keeper.js) so the server can give
// it priority as the stable, always-on host over a transient human tab.
const IS_KEEPER = (() => {
  try { return new URLSearchParams(location.search).has('mp_host'); }
  catch { return false; }
})();

// Two separate "ready" gates, because the character/persona list and the
// chat log become available at different times and one must not block the
// other:
//
// stReady — set on APP_READY, once SillyTavern has booted and its character
// list is populated. Gates pushSessionInfo (characters, personas, presets).
// This does NOT depend on a chat being open: the keeper's tab often sits at
// the character-select screen with no active chat, and the web client still
// needs the character list so a player can pick one. Gating the list on a
// chat being loaded was a bug — it left the web client stuck on "Waiting for
// extension…" whenever no chat was open.
//
// chatConfirmedLoaded — set on CHAT_CHANGED, once a specific chat has actually
// finished loading. Gates pushChatHistory only, so we never broadcast an empty
// chat during the load storm right after a fresh page load (e.g. keeper's tab
// reloading) that then flips to the real chat a moment later.
//
// Both naturally reset to false on the next page load.
let stReady = false;
let chatConfirmedLoaded = false;

// ──────────── Boot: load socket.io client dynamically ────────────

function boot() {
  const ctx = getContext();
  console.log('[MP] Extension booting. executeSlashCommandsWithOptions available:', typeof ctx.executeSlashCommandsWithOptions === 'function');

  hookToastr();

  const script = document.createElement('script');
  script.src = TARGET_URL + '/socket.io/socket.io.js' + (AUTH_TOKEN ? `?mp_token=${encodeURIComponent(AUTH_TOKEN)}` : '');
  script.onload = () => {
    console.log('[MP] socket.io client loaded');
    connectSocket();
  };
  script.onerror = () => {
    console.error('[MP] Failed to load socket.io client from', TARGET_URL, '— is the MP server running and reachable?');
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
    auth: AUTH_TOKEN ? { token: AUTH_TOKEN } : undefined,
  });

  socket.on('connect', () => {
    console.log('[MP] WebSocket connected');
    lastChatStr = '';
    lastSessionStr = '';

    // Ask the relay whether we're the host. Until it answers (via
    // 'extension-role'), isHost stays false and every push/command is a no-op,
    // so a non-host tab never fights the real host. See isHost's declaration.
    socket.emit('register-extension', { role: IS_KEEPER ? 'keeper' : 'tab' });
    console.log('[MP] Registered as', IS_KEEPER ? 'keeper (host priority)' : 'tab');

    // Fallback for an older relay server that doesn't know 'extension-role':
    // if it never tells us our role, assume host after a moment so a
    // half-upgraded deploy still works instead of going silent.
    setTimeout(() => {
      if (!roleReceived && socket && socket.connected) {
        console.warn('[MP] No role from server — assuming host (old server?)');
        becomeHost();
      }
    }, 3000);
  });

  socket.on('disconnect', () => {
    console.warn('[MP] WebSocket disconnected');
    roleReceived = false;
    isHost = false;
  });

  // ── The relay tells us whether we're the authoritative host ──
  socket.on('extension-role', ({ host } = {}) => {
    roleReceived = true;
    if (host) {
      console.log('[MP] Server designated us HOST');
      becomeHost();
    } else {
      console.log('[MP] Server designated us follower — standing down');
      isHost = false;
    }
  });

  // ── Receive commands from web clients instantly ──
  socket.on('command', (cmd) => {
    if (!isHost) return; // followers never execute — only the host acts
    console.log('[MP] Received command:', cmd.type || 'message');
    // Only commands that actually trigger/extend AI generation need to be
    // serialized against each other (so two players' /trigger calls can't
    // race). Everything else — stop, delete, edit, switching chats, etc. —
    // runs immediately: queuing it behind a prior message's cooldown would
    // make e.g. Stop or Delete sit unresponsive for up to 10 seconds.
    if (GENERATION_COMMAND_TYPES.has(cmd.type || 'message')) {
      queueCommand(cmd);
    } else {
      executeCommand(cmd);
    }
  });

  // Start pushing chat history + session info. This is a slow safety-net
  // poll only — real changes (new/edited/deleted messages, chat switches)
  // are covered by event listeners below, and mid-stream token updates are
  // covered by the STREAM_TOKEN_RECEIVED hook (see below), which reacts to
  // real activity instead of guessing an interval.
  schedulePoll();
}

function schedulePoll() {
  setTimeout(() => { pushChatHistory(); schedulePoll(); }, 6000);
}

// Promoted to host (by the server, or the old-server fallback): push our
// current state so the relay and every web client immediately reflect this
// tab, and announce the real generation state (see the connect handler's
// note on why that matters on every (re)connect / promotion).
function becomeHost() {
  isHost = true;
  lastChatStr = '';
  lastSessionStr = '';
  pushChatHistory();
  pushSessionInfo();
  setGenerating(is_send_press);
}

// ──────────── Push chat history to server ────────────

// Grab ST's own rendered HTML for each message — this already has
// markdown/HTML formatting, macros ({{getvar::x}}, {{char}}, etc.) resolved,
// and any display Regex scripts applied, exactly as SillyTavern shows them.
// Also grabs the reasoning ("thinking") block, if the model/message has one.
// index -> { mes, swipe_id, renderedHtml, reasoningHtml }. Keyed off the
// message content itself (not just the index), so it self-invalidates:
// an edit, swipe, or a delete shifting every later index all change what's
// stored at that position, which is caught by the mes/swipe_id comparison
// below — no need to manually clear this from every command handler.
const renderedCache = new Map();

function getEnrichedChat() {
  const chat = getContext().chat;
  const lastIdx = chat.length - 1;
  const out = new Array(chat.length);
  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    const cached = renderedCache.get(i);
    // Always re-query the last couple of messages — one of them may be
    // actively streaming, so its DOM content can change without msg.mes
    // itself changing until the stream finishes.
    const isTail = i >= lastIdx - 1;
    if (!isTail && cached && cached.mes === msg.mes && cached.swipe_id === msg.swipe_id) {
      out[i] = { ...msg, renderedHtml: cached.renderedHtml, reasoningHtml: cached.reasoningHtml };
      continue;
    }
    const mesBlock = document.querySelector(`#chat .mes[mesid="${i}"] .mes_text`);
    const reasoningBlock = document.querySelector(`#chat .mes[mesid="${i}"] .mes_reasoning`);
    const renderedHtml = mesBlock ? mesBlock.innerHTML : null;
    const reasoningHtml = reasoningBlock ? reasoningBlock.innerHTML : null;
    renderedCache.set(i, { mes: msg.mes, swipe_id: msg.swipe_id, renderedHtml, reasoningHtml });
    out[i] = { ...msg, renderedHtml, reasoningHtml };
  }
  // Drop stale entries past the current chat length (deleted tail, new/switched chat)
  if (renderedCache.size > chat.length) {
    for (const key of renderedCache.keys()) if (key >= chat.length) renderedCache.delete(key);
  }
  return out;
}

function pushChatHistory() {
  if (!socket || !socket.connected) return;
  if (!isHost) return;
  if (!chatConfirmedLoaded) return;
  const enriched = getEnrichedChat();
  const str = JSON.stringify(enriched);
  const changed = str !== lastChatStr;
  if (changed) {
    lastChatStr = str;
    socket.emit('chat-update', enriched);
    // Context/token usage depends on chat content, so refresh session info
    // whenever the chat changes (also picks up new messages' token cost).
    pushSessionInfo();
  }
}

// ──────────── Session info (characters, personas, chats, tokens) ────────────

// Deliberately NOT prefixed with window.location.origin: that would be
// whatever origin this extension's own browser used to reach ST (e.g.
// localhost:8000 through an SSH tunnel), which is meaningless — and often
// blocked outright by the viewer's browser (Private/Local Network Access)
// — for any other player's browser. The MP server proxies /thumbnail
// itself (see server.js), fetching it server-side from ST directly.
function absoluteUrl(relativePath) {
  return relativePath || null;
}

// getContext().maxContext mirrors ST's internal `max_context` variable,
// which is only kept up to date for kobold/text-generation-webui backends.
// For chat-completion (OpenAI-compatible) connections — what any proxy/
// aggregator uses — the real limit lives in chatCompletionSettings
// (oai_settings).openai_max_context instead; ST's own getMaxContextTokens()
// branches on mainApi the same way, it's just not exposed through
// getContext() itself. Without this, every chat-completion connection
// shows ST's small hardcoded default instead of the preset's real value.
function getRealMaxContext(ctx) {
  if (ctx.mainApi === 'openai') {
    return ctx.chatCompletionSettings?.openai_max_context ?? ctx.maxContext;
  }
  return ctx.maxContext;
}

// Token counting for the context meter is expensive: for chat-completion
// (proxy/aggregator) backends ST counts tokens via a real backend request,
// one per message. buildSessionInfo can run several times a second during
// streaming, so counting every message every time would flood the backend.
// Some proxies also 403 the tokenize endpoint intermittently — so a given
// attempt can fail even though the endpoint works most of the time.
//
// Strategy: throttle real counting to once every few seconds (kills the
// flood while still retrying), and NEVER permanently give up — every
// throttled round tries a real count again, so the meter self-heals the
// moment the endpoint answers. A failed round falls back to the last real
// count we got (so the meter doesn't drop to 0 or flicker); only if we've
// never once succeeded do we show a rough char-based estimate.
let reportedTokens = 0;
let lastRealTokens = null;      // most recent successful real count, or null
let lastTokenCountAt = 0;
let tokenCountEstimated = false; // true only while we've never had a real count
let loggedTokenErrorDetail = false; // one-time detailed failure diagnostic
const TOKEN_COUNT_THROTTLE_MS = 4000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

function estimateTokens(chat) {
  let chars = 0;
  for (const m of chat) chars += (m.mes || '').length;
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

async function getContextTokens(ctx) {
  const chat = ctx.chat || [];
  const now = Date.now();
  // Throttle: reuse the last reported value within the window, bounding how
  // often we hit the backend regardless of streaming frequency.
  if (lastTokenCountAt !== 0 && now - lastTokenCountAt < TOKEN_COUNT_THROTTLE_MS) {
    return reportedTokens;
  }
  lastTokenCountAt = now;
  try {
    const counts = await Promise.all(chat.map(m => ctx.getTokenCountAsync(m.mes || '')));
    lastRealTokens = counts.reduce((sum, n) => sum + n, 0);
    tokenCountEstimated = false;
    reportedTokens = lastRealTokens;
  } catch (e) {
    // One-time detailed diagnostic: token counting hits ST's own local
    // /api/tokenizers/openai/count, which is CSRF-protected. Log the real
    // failure once (jqXHR status + a snippet of the response body) so we can
    // see WHY it 403s — invalid CSRF token, whitelist, auth — instead of
    // guessing. jQuery rejects with a jqXHR object.
    if (!loggedTokenErrorDetail) {
      loggedTokenErrorDetail = true;
      try {
        const status = e?.status ?? e?.jqXHR?.status;
        const body = (e?.responseText ?? e?.jqXHR?.responseText ?? e?.message ?? String(e));
        console.warn('[MP] token count error detail — status:', status, 'body:', String(body).slice(0, 300));
      } catch (_) {
        console.warn('[MP] token count error (unloggable shape):', e);
      }
    }
    // This round's tokenize request failed. Keep showing the last real count
    // if we ever had one — the next throttled round will try again and
    // self-heal. Only estimate if we've never succeeded, so the meter shows
    // something instead of 0.
    if (lastRealTokens !== null) {
      reportedTokens = lastRealTokens;
    } else {
      reportedTokens = estimateTokens(chat);
      tokenCountEstimated = true;
    }
  }
  return reportedTokens;
}

async function buildSessionInfo() {
  const ctx = getContext();

  const characters = (ctx.characters || []).map(c => ({
    id: c.avatar,
    name: c.name,
    avatarUrl: absoluteUrl(ctx.getThumbnailUrl('avatar', c.avatar)),
  }));

  const currentChar = (ctx.characterId !== undefined && ctx.characters[ctx.characterId])
    ? ctx.characters[ctx.characterId]
    : null;
  const character = currentChar
    ? { id: currentChar.avatar, name: currentChar.name, avatarUrl: absoluteUrl(ctx.getThumbnailUrl('avatar', currentChar.avatar)) }
    : null;

  const personasMap = ctx.powerUserSettings?.personas || {};
  const personas = Object.entries(personasMap).map(([id, name]) => ({
    id,
    name,
    avatarUrl: absoluteUrl(ctx.getThumbnailUrl('persona', id)),
  }));

  const contextTokens = await getContextTokens(ctx);

  return {
    character,
    chatId: ctx.chatId ?? null,
    maxContext: getRealMaxContext(ctx),
    contextTokens,
    contextTokensEstimated: tokenCountEstimated,
    characters,
    personas,
    activePersonaId: user_avatar,
    activePersonaName: ctx.name1,
  };
}

async function pushSessionInfo() {
  if (!socket || !socket.connected) return;
  if (!isHost) return;
  if (!stReady) return;
  const info = await buildSessionInfo();
  const str = JSON.stringify(info);
  if (str === lastSessionStr) return;
  lastSessionStr = str;
  socket.emit('session-info', info);
}

// ──────────── Generation status (visible to all players) ────────────

let lastReportedGenerating = false;
let pendingGenTimer = null;

// Debounce the "generating" ON edge: SillyTavern's own chat-load / character-
// switch routines (openCharacterChat, /go) can pulse GENERATION_STARTED for
// a moment without a real LLM call happening, which otherwise flashes a
// bogus "X is generating…" banner for everyone. The OFF edge stays instant
// so a real stop/end is never delayed.
function setGenerating(generating) {
  if (pendingGenTimer) {
    clearTimeout(pendingGenTimer);
    pendingGenTimer = null;
  }
  if (!generating) {
    lastReportedGenerating = false;
    emitGenerating(false);
    return;
  }
  pendingGenTimer = setTimeout(() => {
    pendingGenTimer = null;
    lastReportedGenerating = true;
    emitGenerating(true);
  }, 300);
}

function emitGenerating(generating) {
  if (!socket || !socket.connected) return;
  if (!isHost) return;
  const ctx = getContext();
  socket.emit('generation-status', {
    generating,
    characterName: ctx.name2 || null,
  });
}

// Belt-and-braces reconciliation: SillyTavern's GENERATION_STARTED/STOPPED/
// ENDED events are the normal signal, but an aborted/errored generation can
// occasionally leave them out of sync with the real is_send_press state
// (observed after a programmatic /stop mid-stream, which can throw inside
// ST's own generation pipeline before it gets to emit GENERATION_ENDED).
// Polling catches and self-heals any such drift within a couple of seconds
// instead of leaving every player's input stuck disabled indefinitely.
setInterval(() => {
  if (is_send_press !== lastReportedGenerating) {
    setGenerating(is_send_press);
  }
}, 2000);

// ──────────── Errors (relayed from ST's own toast notifications) ────────────

function hookToastr() {
  if (typeof toastr === 'undefined' || typeof toastr.subscribe !== 'function') {
    console.warn('[MP] toastr.subscribe not available, errors will not be relayed');
    return;
  }
  toastr.subscribe((args) => {
    if (args.state !== 'visible') return;
    const type = args.map?.type;
    if (type !== 'error' && type !== 'warning') return;
    const rawMessage = args.map?.message;
    if (!rawMessage) return;
    const message = String(rawMessage).replace(/<[^>]+>/g, '').trim();
    if (!message) return;
    if (isHost && socket && socket.connected) {
      socket.emit('error', { type, message });
    }
  });
}

// ──────────── Command processing ────────────

// Only these actually start/extend a generation, so only these need to wait
// their turn behind one another. Everything else executes immediately (see
// the 'command' socket handler above).
const GENERATION_COMMAND_TYPES = new Set(['message', 'swipe', 'regenerate', 'continue']);

function queueCommand(cmd) {
  commandQueue.push(cmd);
  if (!processing) processNext();
}

function processNext() {
  if (commandQueue.length === 0) { processing = false; return; }
  processing = true;
  const cmd = commandQueue.shift();
  executeCommand(cmd);
  // Move on as soon as generation has actually finished instead of always
  // waiting out the old worst-case fixed delay — a fast model/API done in
  // 1-2s no longer blocks the next queued player action for up to 10s.
  // Still caps at the same delay as before as a safety net, so this can
  // only ever be faster, never slower.
  const maxDelay = cmd.type === 'message' ? 10000 : 1500;
  waitThenNext(maxDelay);
}

function waitThenNext(maxDelay) {
  const deadline = Date.now() + maxDelay;
  // Give ST's async STscript a moment to actually start generating before
  // checking is_send_press, so we don't race ahead on a stale "false".
  const graceUntil = Date.now() + 400;
  (function poll() {
    const now = Date.now();
    if (now >= deadline || (now >= graceUntil && !is_send_press)) {
      processNext();
      return;
    }
    setTimeout(poll, 250);
  })();
}

function executeCommand(cmd) {
  if (!cmd.type) {
    sendMessageAs(cmd.personaId, cmd.message);
    return;
  }
  switch (cmd.type) {
    case 'message':         sendMessageAs(cmd.personaId, cmd.message); break;
    case 'swipe':            handleSwipe(cmd.direction); break;
    case 'regenerate':       handleRegenerate(); break;
    case 'edit':              handleEdit(cmd.index, cmd.text); break;
    case 'delete':           handleDelete(cmd.index); break;
    case 'stop':              handleStop(); break;
    case 'continue':         handleContinue(); break;
    case 'switch-character': handleSwitchCharacter(cmd.characterId); break;
    case 'new-chat':         handleNewChat(); break;
    case 'load-chat':        handleLoadChat(cmd.fileName); break;
    case 'delete-chat':      handleDeleteChat(cmd.fileName); break;
    case 'list-chats':       handleListChats(); break;
    case 'list-models':      handleListModels(); break;
    case 'set-model':        handleSetModel(cmd.model); break;
    case 'list-presets':     handleListPresets(); break;
    case 'set-preset':       handleSetPreset(cmd.preset); break;
    default: console.warn('[MP] Unknown command:', cmd.type);
  }
}

// ──────────── STscript arg helpers ────────────

// Escape characters that would break STscript command chaining (used for
// arguments that keep literal text, e.g. /send's rawQuotes message body).
function stEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

// Quote an argument if it contains whitespace or the command separator.
// STscript's normal (non-rawQuotes) argument parser strips wrapping quotes,
// so this is how you pass e.g. a character/persona name with spaces.
function stQuoteArg(str) {
  const s = String(str);
  if (/[\s|]/.test(s)) {
    return '"' + s.replace(/"/g, '\\"') + '"';
  }
  return s;
}

// ──────────── Send message as persona (via STscript) ────────────

async function sendMessageAs(personaId, message) {
  console.log('[MP] Sending as persona:', personaId);
  const ctx = getContext();

  // Snap back to whoever's persona was active before this message, once
  // it's sent — otherwise the tavern is left showing the last remote
  // player's persona indefinitely, which is wrong if the host is typing
  // directly into ST themselves, or just looking at their own screen.
  const previousPersonaId = user_avatar;
  const restore = previousPersonaId && previousPersonaId !== personaId
    ? ` | /persona-set mode=lookup ${stQuoteArg(previousPersonaId)}`
    : '';

  const safeMessage = stEscape(message);
  const script = `/persona-set mode=lookup ${stQuoteArg(personaId)} | /send ${safeMessage} | /trigger${restore}`;

  try {
    await ctx.executeSlashCommandsWithOptions(script);
    console.log('[MP] Sent via STscript');
  } catch (e) {
    console.error('[MP] STscript send failed:', e);
  }
}

// ──────────── Swipe ────────────

async function handleSwipe(direction) {
  console.log('[MP] Swipe:', direction);
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions(`/swipe direction=${direction === 'left' ? 'left' : 'right'}`);
    console.log('[MP] Swiped via STscript:', direction);
  } catch (e) {
    console.warn('[MP] /swipe STscript failed:', e);
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
  } catch (e) {
    console.warn('[MP] /regenerate STscript failed:', e);
  }
  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 3000);
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

// ──────────── Delete (via STscript /cut) ────────────

async function handleDelete(index) {
  console.log('[MP] Delete index:', index);
  const ctx = getContext();
  if (index < 0 || index >= ctx.chat.length) return;

  try {
    await ctx.executeSlashCommandsWithOptions(`/cut ${index}`);
    console.log('[MP] Deleted via STscript');
  } catch (e) {
    console.warn('[MP] /cut STscript failed, falling back to context.deleteMessage:', e);
    try {
      await ctx.deleteMessage(index);
    } catch (e2) {
      console.error('[MP] deleteMessage fallback failed:', e2);
    }
  }
  lastChatStr = '';
  pushChatHistory();
}

// ──────────── Stop generation ────────────

// SillyTavern's own /stop command just calls context.stopGeneration() under
// the hood, and its docs note it can't run from the visible chat input box
// during generation — calling the context function directly sidesteps that
// UI-only restriction, which doesn't apply to a programmatic extension call.
function handleStop() {
  console.log('[MP] Stop generation');
  const ctx = getContext();
  const stopped = ctx.stopGeneration();
  console.log('[MP] Stop result:', stopped);
}

// ──────────── Continue last message (via STscript) ────────────

async function handleContinue() {
  console.log('[MP] Continue');
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions('/continue');
    console.log('[MP] Continued via STscript');
  } catch (e) {
    console.warn('[MP] /continue STscript failed:', e);
  }
  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 3000);
}

// ──────────── Switch character (via STscript /go) ────────────

async function handleSwitchCharacter(characterId) {
  console.log('[MP] Switch character:', characterId);
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions(`/go ${stQuoteArg(characterId)}`);
  } catch (e) {
    console.error('[MP] /go failed:', e);
  }
  lastChatStr = '';
  lastSessionStr = '';
  pushChatHistory();
  pushSessionInfo();
}

// ──────────── New chat (via STscript) ────────────

async function handleNewChat() {
  console.log('[MP] New chat');
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions('/newchat delete=false');
  } catch (e) {
    console.error('[MP] /newchat failed:', e);
  }
  lastChatStr = '';
  lastSessionStr = '';
  pushChatHistory();
  pushSessionInfo();
}

// ──────────── Load a past chat (native context API — no STscript equivalent) ────────────

async function handleLoadChat(fileName) {
  console.log('[MP] Load chat:', fileName);
  if (!fileName) return;
  const ctx = getContext();
  try {
    await ctx.openCharacterChat(fileName);
  } catch (e) {
    console.error('[MP] openCharacterChat failed:', e);
  }
  lastChatStr = '';
  lastSessionStr = '';
  pushChatHistory();
  pushSessionInfo();
}

// ──────────── Delete a past chat (native REST endpoint — no STscript equivalent) ────────────

async function handleDeleteChat(fileName) {
  console.log('[MP] Delete chat:', fileName);
  if (!fileName) return;
  const ctx = getContext();
  try {
    if (!ctx.groupId && ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
      const avatar = ctx.characters[ctx.characterId].avatar;
      const res = await fetch('/api/chats/delete', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ chatfile: fileName, avatar_url: avatar }),
      });
      if (!res.ok) console.error('[MP] delete-chat failed:', res.status);
    }
  } catch (e) {
    console.error('[MP] delete-chat failed:', e);
  }

  // If the deleted file was the one currently open, start a fresh chat so
  // nothing is left pointing at a file that no longer exists.
  if (fileName === ctx.chatId) {
    await handleNewChat();
  } else {
    lastChatStr = '';
    lastSessionStr = '';
    pushChatHistory();
    pushSessionInfo();
  }
  handleListChats();
}

// ──────────── Model selection ────────────

// ST doesn't expose "the list of models for the active connection" through
// getContext() — its own /model slash command reads it straight out of the
// matching settings-panel DOM control (a <select>, or an <input> with a
// <datalist>, depending on API/source), so we mirror that same lookup
// rather than reimplementing model-list fetching per API. This map is
// SillyTavern's own modelSelectMap (slash-commands.js), by API + sub-type.
const MODEL_SELECT_MAP = {
  'textgenerationwebui:generic': 'generic_model_textgenerationwebui',
  'textgenerationwebui:ooba': 'custom_model_textgenerationwebui',
  'textgenerationwebui:togetherai': 'model_togetherai_select',
  'textgenerationwebui:openrouter': 'openrouter_model',
  'textgenerationwebui:infermaticai': 'model_infermaticai_select',
  'textgenerationwebui:dreamgen': 'model_dreamgen_select',
  'textgenerationwebui:mancer': 'mancer_model',
  'textgenerationwebui:vllm': 'vllm_model',
  'textgenerationwebui:aphrodite': 'aphrodite_model',
  'textgenerationwebui:ollama': 'ollama_model',
  'textgenerationwebui:tabby': 'tabby_model',
  'textgenerationwebui:llamacpp': 'llamacpp_model',
  'textgenerationwebui:featherless': 'featherless_model',
  'openai:openai': 'model_openai_select',
  'openai:claude': 'model_claude_select',
  'openai:openrouter': 'model_openrouter_select',
  'openai:ai21': 'model_ai21_select',
  'openai:makersuite': 'model_google_select',
  'openai:vertexai': 'model_vertexai_select',
  'openai:mistralai': 'model_mistralai_select',
  'openai:custom': 'custom_model_id',
  'openai:cohere': 'model_cohere_select',
  'openai:perplexity': 'model_perplexity_select',
  'openai:groq': 'model_groq_select',
  'openai:chutes': 'model_chutes_select',
  'openai:siliconflow': 'model_siliconflow_select',
  'openai:minimax': 'model_minimax_select',
  'openai:electronhub': 'model_electronhub_select',
  'openai:nanogpt': 'model_nanogpt_select',
  'openai:deepseek': 'model_deepseek_select',
  'openai:aimlapi': 'model_aimlapi_select',
  'openai:xai': 'model_xai_select',
  'openai:pollinations': 'model_pollinations_select',
  'openai:moonshot': 'model_moonshot_select',
  'openai:fireworks': 'model_fireworks_select',
  'openai:cometapi': 'model_cometapi_select',
  'openai:zai': 'model_zai_select',
  'openai:workers_ai': 'model_workers_ai_select',
  'novel:null': 'model_novel_select',
  'koboldhorde:null': 'horde_model',
};

function getModelSelectControl(ctx) {
  const api = ctx.mainApi;
  let subType = null;
  if (api === 'textgenerationwebui') subType = ctx.textCompletionSettings?.type ?? null;
  else if (api === 'openai') subType = ctx.chatCompletionSettings?.chat_completion_source ?? null;
  const id = MODEL_SELECT_MAP[`${api}:${subType}`];
  return id ? document.getElementById(id) : null;
}

function handleListModels() {
  const ctx = getContext();
  let options = [];
  let current = '';
  try {
    const el = getModelSelectControl(ctx);
    if (el instanceof HTMLSelectElement) {
      current = el.value;
      options = [...el.options].filter(o => o.value).map(o => ({ value: o.value, text: o.textContent || o.value }));
    } else if (el instanceof HTMLInputElement) {
      current = el.value;
      if (el.list) options = [...el.list.options].map(o => ({ value: o.value, text: o.textContent || o.value }));
    }
  } catch (e) {
    console.error('[MP] list-models failed:', e);
  }
  if (socket && socket.connected) socket.emit('models-list', { current, options });
}

async function handleSetModel(model) {
  if (!model) return;
  console.log('[MP] Set model:', model);
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions(`/model quiet=true ${stQuoteArg(model)}`);
  } catch (e) {
    console.error('[MP] /model failed:', e);
  }
  lastSessionStr = '';
  pushSessionInfo();
}

// ──────────── Preset selection ────────────

function handleListPresets() {
  const ctx = getContext();
  let options = [];
  let current = '';
  try {
    const pm = ctx.getPresetManager();
    if (pm) {
      options = pm.getAllPresets() || [];
      current = pm.getSelectedPresetName() || '';
    }
  } catch (e) {
    console.error('[MP] list-presets failed:', e);
  }
  if (socket && socket.connected) socket.emit('presets-list', { current, options });
}

async function handleSetPreset(name) {
  if (!name) return;
  console.log('[MP] Set preset:', name);
  const ctx = getContext();
  try {
    await ctx.executeSlashCommandsWithOptions(`/preset ${stQuoteArg(name)}`);
  } catch (e) {
    console.error('[MP] /preset failed:', e);
  }
  lastSessionStr = '';
  pushSessionInfo();
}

// ──────────── List past chats for the current character ────────────

async function handleListChats() {
  const ctx = getContext();
  let chats = [];
  try {
    if (!ctx.groupId && ctx.characterId !== undefined && ctx.characters[ctx.characterId]) {
      const avatar = ctx.characters[ctx.characterId].avatar;
      const res = await fetch('/api/chats/search', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ query: '', avatar_url: avatar, group_id: null }),
      });
      if (res.ok) {
        const data = await res.json();
        chats = data.map(c => ({
          fileName: c.file_name,
          messageCount: c.message_count,
          preview: c.preview_message,
          lastMessageAt: c.last_mes,
        }));
      }
    }
  } catch (e) {
    console.error('[MP] list-chats failed:', e);
  }

  if (socket && socket.connected) {
    socket.emit('chats-list', { characterId: ctx.characters[ctx.characterId]?.avatar ?? null, chats });
  }
}

// ──────────── Init ────────────

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
  // Force push on new messages for faster sync
  lastChatStr = '';
  pushChatHistory();
  // Retry shortly after — DOM render can lag slightly behind this event
  setTimeout(() => { lastChatStr = ''; pushChatHistory(); }, 500);
});

// Fires on every streamed chunk during generation — debounced instead of
// pushed on every single token (which can fire many times a second) so
// players still watch it type live, without pushing far more often than
// anyone could perceive. Real activity, not a guessed interval, drives
// the rate — the old flat 700ms poll during generation is gone.
if (event_types.STREAM_TOKEN_RECEIVED) {
  let streamDebounceTimer = null;
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
    if (streamDebounceTimer) return;
    streamDebounceTimer = setTimeout(() => {
      streamDebounceTimer = null;
      lastChatStr = '';
      pushChatHistory();
    }, 250);
  });
}

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

// SillyTavern has booted and its character list is loaded — the web client
// can be given the session info (characters/personas/presets) now, even if no
// chat is open yet (e.g. keeper's tab sitting at the character-select screen).
if (event_types.APP_READY) {
  eventSource.on(event_types.APP_READY, () => {
    stReady = true;
    lastSessionStr = '';
    pushSessionInfo();
    // Belt-and-braces: if the character list wasn't fully populated the very
    // instant APP_READY fired, re-push shortly after so the web client doesn't
    // stick on an empty "No characters found".
    setTimeout(() => { lastSessionStr = ''; pushSessionInfo(); }, 800);
  });
}

// Chat/persona switches change session info (and the whole chat log)
eventSource.on(event_types.CHAT_CHANGED, () => {
  stReady = true;
  chatConfirmedLoaded = true;
  lastChatStr = '';
  lastSessionStr = '';
  pushChatHistory();
  pushSessionInfo();
});
if (event_types.PERSONA_CHANGED) {
  eventSource.on(event_types.PERSONA_CHANGED, () => {
    lastSessionStr = '';
    pushSessionInfo();
  });
}

// Generation status, visible to every player
// GENERATION_STARTED's first argument is the generation type. 'quiet' is
// ST's own background/internal LLM calls (e.g. the Memory extension
// re-summarizing the chat on load) — not a real reply anyone is waiting
// on, so it shouldn't show "X is generating…" to every player.
eventSource.on(event_types.GENERATION_STARTED, (type) => {
  if (type === 'quiet') return;
  setGenerating(true);
});
eventSource.on(event_types.GENERATION_STOPPED, () => setGenerating(false));
eventSource.on(event_types.GENERATION_ENDED, () => setGenerating(false));

boot();
