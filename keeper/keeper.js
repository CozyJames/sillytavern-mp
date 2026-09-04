// Keeps a headless Chromium tab open on the SillyTavern page so the
// mp-extension stays connected 24/7, without needing a real browser/tunnel.
// Requires: apt install -y chromium, npm install puppeteer-core chokidar
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

      // SillyTavern re-saves some of its own files (settings.json, QuickReplies/Default.json)
      // every time the page loads, with the same content - without this, that self-triggered
      // write would trip the watcher, cause a reload, which triggers the same save again,
      // forever. So a write only counts as a real change if the file's content actually
      // differs from what we last saw. Baseline every existing file up front so the very
      // first reload after startup doesn't get misread as a change too.
      const fileHashes = new Map();
      const hashFile = (p) => {
        try {
          return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
        } catch {
          return null;
        }
      };
      const walkFiles = (p) => {
        const stat = fs.statSync(p, { throwIfNoEntry: false });
        if (!stat) return [];
        if (stat.isFile()) return [p];
        if (!stat.isDirectory()) return [];
        return fs.readdirSync(p).flatMap((entry) => walkFiles(path.join(p, entry)));
      };
      for (const root of watchPaths) {
        for (const f of walkFiles(root)) fileHashes.set(f, hashFile(f));
      }

      let debounceTimer = null;
      const watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        // ST saves files atomically (write to a temp file, then rename over the original) -
        // these numbered temp files are never the real file, just noise.
        ignored: /\.\d+$/,
      });
      watcher.on('all', (event, changedPath) => {
        if (event === 'unlink') {
          fileHashes.delete(changedPath);
        } else if (event === 'add' || event === 'change') {
          const newHash = hashFile(changedPath);
          const oldHash = fileHashes.get(changedPath);
          fileHashes.set(changedPath, newHash);
          if (newHash !== null && newHash === oldHash) {
            return; // same content written again (e.g. ST's own startup save) - not a real change
          }
        }
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
