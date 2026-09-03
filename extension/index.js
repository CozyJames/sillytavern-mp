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
    auth: AUTH_TOKEN ? { token: AUTH_TOKEN } : undefined,
  });

  socket.on('connect', () => {
    console.log('[MP] WebSocket connected');
    lastChatStr = '';
    lastSessionStr = '';
    pushChatHistory();
    pushSessionInfo();
    // Announce the real current generation state on every (re)connect.
    // Without this, a server that cached "generating: true" from a session
    // that dropped mid-generation (tab closed, network blip) would keep
    // showing that forever to every future client — nothing else corrects
    // it, since setGenerating() is otherwise only called by event listeners.
    console.log('[MP] Reporting current generation state on connect:', is_send_press);
    setGenerating(is_send_press);
  });

  socket.on('disconnect', () => {
    console.warn('[MP] WebSocket disconnected');
  });

  // ── Receive commands from web clients instantly ──
  socket.on('command', (cmd) => {
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

  // Start pushing chat history + session info
  setInterval(pushChatHistory, 1500);
}

// ──────────── Push chat history to server ────────────

// Grab ST's own rendered HTML for each message — this already has
// markdown/HTML formatting, macros ({{getvar::x}}, {{char}}, etc.) resolved,
// and any display Regex scripts applied, exactly as SillyTavern shows them.
// Also grabs the reasoning ("thinking") block, if the model/message has one.
function getEnrichedChat() {
  const chat = getContext().chat;
  return chat.map((msg, i) => {
    const mesBlock = document.querySelector(`#chat .mes[mesid="${i}"] .mes_text`);
    const reasoningBlock = document.querySelector(`#chat .mes[mesid="${i}"] .mes_reasoning`);
    return {
      ...msg,
      renderedHtml: mesBlock ? mesBlock.innerHTML : null,
      reasoningHtml: reasoningBlock ? reasoningBlock.innerHTML : null,
    };
  });
}

function pushChatHistory() {
  const enriched = getEnrichedChat();
  const str = JSON.stringify(enriched);
  const changed = str !== lastChatStr;
  if (changed) {
    lastChatStr = str;
    if (socket && socket.connected) {
      socket.emit('chat-update', enriched);
    } else {
      // HTTP fallback
      fetch(TARGET_URL + '/set-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AUTH_TOKEN ? { 'X-MP-Token': AUTH_TOKEN } : {}) },
        body: str,
      }).catch(e => console.error('[MP] HTTP push failed:', e));
    }
  }

  // Context/token usage depends on chat content, so refresh session info
  // whenever the chat changes (also picks up new messages' token cost).
  if (changed) {
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

  let contextTokens = 0;
  try {
    const text = (ctx.chat || []).map(m => m.mes || '').join('\n');
    contextTokens = await ctx.getTokenCountAsync(text);
  } catch (e) {
    console.warn('[MP] Token count failed:', e);
  }

  return {
    character,
    chatId: ctx.chatId ?? null,
    maxContext: getRealMaxContext(ctx),
    contextTokens,
    characters,
    personas,
    activePersonaId: user_avatar,
    activePersonaName: ctx.name1,
  };
}

async function pushSessionInfo() {
  if (!socket || !socket.connected) return;
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
    if (socket && socket.connected) {
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
  const delay = cmd.type === 'message' ? 10000 : 1500;
  setTimeout(processNext, delay);
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

  const safeMessage = stEscape(message);
  const script = `/persona-set mode=lookup ${stQuoteArg(personaId)} | /send ${safeMessage} | /trigger`;

  try {
    await ctx.executeSlashCommandsWithOptions(script);
    console.log('[MP] Sent via STscript');
  } catch (e) {
    console.error('[MP] STscript send failed:', e);
    sendMessageAsLegacy(personaId, message);
  }
}

function sendMessageAsLegacy(personaId, message) {
  console.log('[MP] Falling back to legacy DOM method');
  const ctx = getContext();
  const personaName = ctx.powerUserSettings?.personas?.[personaId] || personaId;
  $("#user_avatar_block .avatar-container").each((k, v) => {
    if (v.innerText.toLowerCase().includes(String(personaName).toLowerCase())) v.click();
  });
  $("#send_textarea").val(message);
  setTimeout(() => getContext().generate(), 1000);
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

// ──────────── HTTP fallback (if socket.io fails to load) ────────────

function startHttpPolling() {
  console.log('[MP] Starting HTTP polling fallback');
  setInterval(() => {
    pushChatHistory();
    fetch(TARGET_URL + '/queued-messages', {
      headers: AUTH_TOKEN ? { 'X-MP-Token': AUTH_TOKEN } : {},
    })
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

// Chat/persona switches change session info (and the whole chat log)
eventSource.on(event_types.CHAT_CHANGED, () => {
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
