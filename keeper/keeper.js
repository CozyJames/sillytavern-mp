// Keeps a headless Chromium tab open on the SillyTavern page so the
// mp-extension stays connected 24/7, without needing a real browser/tunnel.
// Requires: apt install -y chromium, npm install puppeteer-core
const puppeteer = require('puppeteer-core');

const ST_URL = process.env.ST_URL || 'http://127.0.0.1:8000';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium-browser';
const RELOAD_MS = 30 * 60 * 1000; // reload every 30 min in case the tab wedges

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });

  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[page]', msg.text()));
  page.on('error', (err) => console.error('[page-crash]', err));

  async function load() {
    console.log('[keeper] loading', ST_URL);
    await page.goto(ST_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[keeper] loaded');
  }

  await load();
  setInterval(() => load().catch((e) => console.error('[keeper] reload failed', e)), RELOAD_MS);

  browser.on('disconnected', () => {
    console.error('[keeper] browser disconnected, exiting so systemd restarts us');
    process.exit(1);
  });
}

main().catch((e) => {
  console.error('[keeper] fatal', e);
  process.exit(1);
});
