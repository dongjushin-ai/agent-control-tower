// Regenerates docs/assets/*.png from the built-in demo data.
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`). Not a runtime dependency.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = readFileSync(join(ROOT, 'dashboard', file));
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();

const shots = [
  { name: 'dashboard-light.png', theme: 'light', width: 1180, height: 1000 },
  { name: 'dashboard-dark.png', theme: 'dark', width: 1180, height: 1000 },
  { name: 'dashboard-mobile.png', theme: 'dark', width: 390, height: 1400, scale: 2 },
  { name: 'dashboard-ko.png', theme: 'light', width: 1180, height: 1000, lang: 'ko' }
];
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.scale || 2, colorScheme: s.theme, timezoneId: s.lang === 'ko' ? 'Asia/Seoul' : 'America/New_York', locale: s.lang === 'ko' ? 'ko-KR' : 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/?demo&theme=${s.theme}${s.lang ? '&lang=' + s.lang : ''}`);
  await page.waitForSelector('.card');
  await page.screenshot({ path: join(ROOT, 'docs', 'assets', s.name), fullPage: s.width < 500 });
  console.log('wrote docs/assets/' + s.name);
  await page.close();
}
await browser.close();
server.close();
