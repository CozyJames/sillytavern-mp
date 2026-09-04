// Keeps a headless Chromium tab open on the SillyTavern page so the
// mp-extension stays connected 24/7, without needing a real browser/tunnel.
// Requires: apt install -y chromium, npm install puppeteer-core chokidar
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chokidar = require('chokidar');

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8000';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium-browser';
const RELOAD_MS = 30 * 60 * 1000; // fallback safety net, in case the tab wedges silently

// Optional: SillyTavern's per-user data folder, e.g. .../SillyTavern/data/default-user
// When set, keeper watches it for real settings changes (presets, characters, world
// info, personas) and reloads promptly instead of waiting for the 30-minute timer.
// Deliberately excludes 'chats'/'group chats' (written on every message during normal
// play — watching those would reload the tab constantly and break live sessions) and
// 'thumbnails*' (regenerated cache, not user-authored data).
const ST_DATA_PATH = process.env.ST_DATA_PATH || '';
const WATCHED_SUBPATHS = [
  'settings.json', // persona list + most ST-wide settings live here
  'characters',
  'worlds',
  'groups',
  'OpenAI Settings',
  'NovelAI Settings',
  'KoboldAI Settings',
  'TextGen Settings',
  'instruct',
  'context',
  'QuickReplies',
  'sysprompt',
  'reasoning',
];
const WATCH_DEBOUNCE_MS = 3000; // settle time so one save (which can touch several files) reloads once

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });

  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[page]', msg.text()));
  page.on('error', (err) => console.error('[page-crash]', err));

  let loading = null;
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      console.log('[keeper] loading', ST_URL);
      await page.goto(ST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log('[keeper] loaded');
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  await load();
  setInterval(() => load().catch((e) => console.error('[keeper] reload failed', e)), RELOAD_MS);

  if (ST_DATA_PATH) {
    const watchPaths = WATCHED_SUBPATHS.map((p) => path.join(ST_DATA_PATH, p)).filter((p) => fs.existsSync(p));
    if (watchPaths.length > 0) {
      console.log('[keeper] watching for ST data changes:', watchPaths.join(', '));
      let debounceTimer = null;
      const watcher = chokidar.watch(watchPaths, { ignoreInitial: true });
      watcher.on('all', (event, changedPath) => {
        console.log('[keeper] detected change:', event, changedPath);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          load().catch((e) => console.error('[keeper] reload after data change failed', e));
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', (e) => console.error('[keeper] watcher error', e));
    } else {
      console.warn('[keeper] ST_DATA_PATH is set but none of the expected subfolders exist there:', ST_DATA_PATH);
    }
  } else {
    console.log('[keeper] ST_DATA_PATH not set — relying on the 30-minute timer only, see README');
  }

  browser.on('disconnected', () => {
    console.error('[keeper] browser disconnected, exiting so systemd restarts us');
    process.exit(1);
  });
}

main().catch((e) => {
  console.error('[keeper] fatal', e);
  process.exit(1);
});
