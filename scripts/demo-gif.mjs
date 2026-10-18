// Regenerates docs/assets/demo.gif and docs/assets/cli.gif.
//
//   node scripts/demo-gif.mjs
//
// Needs Playwright with Chromium and ffmpeg on PATH. Not a runtime dependency (not in the npm package).
// Everything shown is fake: the dashboard runs through the real `serve` command on a throwaway tower
// directory filled with demo records, and Playwright's clock plays the hours forward.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'assets');
const BIN = join(ROOT, 'bin', 'tower.mjs');
const core = require('../dashboard/tower-core.js');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const HOUR = 3600 * 1000;
const WORK = mkdtempSync(join(tmpdir(), 'tower-gif-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpegGif(frames, gif, { width, fps = 10 }) {
  // frames: [{ file, seconds }] -> concat list with durations -> palette -> gif
  const list = frames.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;
  const listFile = join(WORK, 'list.txt');
  writeFileSync(listFile, list);
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-filter_complex', `[0:v]${vf},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
  console.log('wrote ' + gif);
}

// ------------------------------------------------------------- dashboard
const OK_TEXT = ['Checked 42 products, no changes', 'Checked 42 products, 2 price drops found'];

function buildLogs(V) {
  const demo = core.demoData(V);
  const byTask = {};
  const horizon = V + 6 * HOUR;
  for (const t of demo.config.tasks) {
    let list = demo.byTask[t.id].map((r) => ({ ...r })); // newest first
    if (list.length) {
      // a calm board to start with: every latest result is ok
      list[0].status = 'ok';
      if (t.id === 'pr-triage') list[0].summary = '[demo] Labeled 6 PRs, requested review on 2';
      if (t.id === 'inbox-digest') list[0].summary = '[demo] Digest sent: 11 threads, 1 needs a reply';
      delete list[0].link;
    }
    if (t.enabled === false) {
      byTask[t.id] = [];
      continue;
    }
    const every = t.everyHours * HOUR;
    if (t.id === 'price-watcher') {
      // it ran fine until 1.4h ago (a real run), then the agent died and wrote nothing
      const last = V - 0.35 * every;
      const firstOld = Date.parse(list[0].at);
      const fill = [];
      for (let at = last; at > firstOld + HOUR; at -= every) {
        fill.push({ v: core.SCHEMA_VERSION, task: t.id, at: new Date(Math.round(at / 1000) * 1000).toISOString(), status: 'ok', summary: '[demo] ' + OK_TEXT[Math.round(at / HOUR) % 2] });
      }
      list = fill.concat(list);
    } else {
      // keep running on schedule after "now", so only the price watcher goes quiet
      let at = Date.parse(list[0].at) + every;
      const extra = [];
      while (at < horizon) {
        const rec = { v: core.SCHEMA_VERSION, task: t.id, at: new Date(Math.round(at / 1000) * 1000).toISOString(), status: 'ok', summary: list[0].summary };
        if (t.kind === 'cron') rec.duration = 41;
        extra.unshift(rec);
        at += every;
      }
      list = extra.concat(list);
    }
    byTask[t.id] = list;
  }
  return { config: demo.config, byTask };
}

function writeLogs(dir, data, until) {
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(dir, 'tower.config.json'), JSON.stringify(data.config, null, 2));
  for (const [id, list] of Object.entries(data.byTask)) {
    const rows = list.filter((r) => Date.parse(r.at) <= until).reverse();
    writeFileSync(join(logs, id + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }
}

async function dashboardGif(browser) {
  const V = Date.parse(new Date().toISOString().slice(0, 13) + ':15:00Z'); // "now", on a tidy minute
  const data = buildLogs(V);
  const dir = join(WORK, 'tower');
  writeLogs(dir, data, V);
  const port = 18700 + Math.floor(Math.random() * 200);
  const server = spawn(process.execPath, [BIN, 'serve', '--dir', dir, '--port', String(port)], { stdio: 'ignore' });
  await sleep(800);

  const frames = [];
  const shotDir = join(WORK, 'dash');
  mkdirSync(shotDir);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1, colorScheme: 'light', timezoneId: 'America/New_York', locale: 'en-US' });
    await page.clock.install({ time: V });
    await page.goto(`http://127.0.0.1:${port}/?theme=light`);
    await page.waitForSelector('.card');

    const caption = (text, hours) =>
      page.evaluate(
        ({ text, hours }) => {
          let el = document.getElementById('demo-caption');
          if (!el) {
            el = document.createElement('div');
            el.id = 'demo-caption';
            el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99;background:#111;color:#fff;border:1px solid rgba(255,255,255,.28);font:600 17px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;padding:11px 20px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap;display:flex;gap:14px;align-items:center';
            document.documentElement.appendChild(el);
          }
          el.innerHTML = '<span style="opacity:.6;font-weight:500;font-variant-numeric:tabular-nums">' + hours + '</span><span>' + text + '</span>';
        },
        { text, hours }
      );
    const snap = async (name, seconds) => {
      const file = join(shotDir, name + '.png');
      await page.mouse.move(2, 2);
      await page.screenshot({ path: file });
      frames.push({ file, seconds });
    };
    const goto = async (hours) => {
      writeLogs(dir, data, V + hours * HOUR);
      await page.clock.setSystemTime(V + hours * HOUR);
      await page.click('#refresh');
      await sleep(350);
    };

    // 1. calm board
    await caption('Every run leaves one line in git. All healthy.', 'now');
    await snap('a0', 3.4);

    // 2. the price watcher's agent dies; hours pass; nothing is written
    const scrollTo = (y) => page.evaluate((y) => window.scrollTo(0, y), y);
    for (const h of [1, 2, 3, 4]) {
      await goto(h);
      // follow the price watcher's card while it is still "Healthy" (it sorts to the top once it is silent)
      await scrollTo(await page.evaluate(() => Math.max(0, [...document.querySelectorAll('.card')].find((c) => /Price watcher/.test(c.textContent)).getBoundingClientRect().top + window.scrollY - 24)));
      await sleep(120);
      await caption('The price watcher crashes. It writes nothing.', `+${h}h`);
      await snap('b' + h, 1.1);
    }

    // 3. silence becomes a verdict
    await goto(5);
    await scrollTo(0);
    await sleep(120);
    await caption('Quiet past its schedule: Silent. The watchdog goes red.', '+5h');
    await snap('c0', 4.6);

    // 4. dark mode
    await page.click('#theme'); // auto -> light (already forced by ?theme=light, so cycle until dark)
    for (let i = 0; i < 3 && (await page.textContent('#theme')) !== 'Dark'; i++) await page.click('#theme');
    await sleep(250);
    await caption('Static page. Light and dark. No server.', '+5h');
    await snap('d0', 3.6);
    await page.close();
  } finally {
    server.kill();
  }
  const gif = join(OUT, 'demo.gif');
  ffmpegGif(frames, gif, { width: 1000, fps: 10 });
}

// ------------------------------------------------------------------- CLI
function sh(cwd, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, TOWER_DIR: '', NO_COLOR: '1', ...extraEnv } });
  return { out: (r.stdout + r.stderr).replace(/\s+$/, ''), code: r.status };
}

async function cliGif(browser) {
  const cwd = mkdtempSync(join(tmpdir(), 'tower-cli-')); // outside WORK so the CLI cannot find the dashboard demo's tower/ dir
  sh(cwd, ['init', '--task', 'db-backup', '--name', 'Postgres backup', '--every', '1']);
  sh(cwd, ['log', '--task', 'db-backup', '--status', 'ok', '--summary', 'exit 0 in 41s']);
  sh(cwd, ['log', '--task', 'price-watcher', '--name', 'Price watcher', '--every', '4', '--status', 'ok', '--summary', 'Checked 42 products, 2 price drops found']);
  sh(cwd, ['log', '--task', 'nightly-research', '--name', 'Nightly research agent', '--every', '24', '--status', 'ok', '--summary', 'Read 14 new papers, wrote 3 notes']);
  const log = sh(cwd, ['log', '--task', 'nightly-research', '--status', 'fail', '--summary', 'Stopped at step 2: search tool returned 0 results']);
  const status = sh(cwd, ['status', '--offline']);
  rmSync(cwd, { recursive: true, force: true });
  const lines = [
    { cmd: 'npx agent-control-tower log --task nightly-research --status fail \\\n    --summary "Stopped at step 2: search tool returned 0 results"', out: log.out },
    { cmd: 'npx agent-control-tower status', out: status.out, code: status.code },
    { cmd: 'echo $?', out: String(status.code) }
  ];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = (n, typing) => {
    // n = how many blocks are fully shown; typing = (blockIndex, chars) of the command being typed
    let body = '';
    lines.forEach((l, i) => {
      if (i > n) return;
      const cmd = i === n && typing !== undefined ? l.cmd.slice(0, typing) : l.cmd;
      body += `<div class="p"><span class="d">$</span> ${esc(cmd)}${i === n && typing !== undefined ? '<span class="cur"></span>' : ''}</div>`;
      if (i < n || (i === n && typing === undefined)) body += `<pre>${esc(l.out)}</pre>`;
    });
    if (n >= lines.length) body += '<div class="p"><span class="d">$</span> <span class="cur"></span></div>';
    return `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#0d1117;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e6edf3}
      .win{width:880px;margin:28px auto;background:#161b22;border:1px solid #30363d;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5)}
      .bar{height:34px;background:#21262d;display:flex;align-items:center;gap:7px;padding-left:14px}
      .bar i{width:12px;height:12px;border-radius:50%;background:#484f58;display:block}
      .bar b{margin-left:14px;font-weight:500;color:#8b949e;font-size:13px}
      .t{padding:16px 20px 22px;min-height:380px}
      .p{white-space:pre-wrap;margin-top:12px}.p:first-child{margin-top:0}
      .d{color:#3fb950}
      pre{margin:4px 0 0;color:#c9d1d9;font:inherit;white-space:pre-wrap}
      .cur{display:inline-block;width:8px;height:16px;background:#e6edf3;vertical-align:-2px;margin-left:1px}
    </style><div class="win"><div class="bar"><i></i><i></i><i></i><b>~/agent-logs</b></div><div class="t">${body}</div></div>`;
  };
  const page = await browser.newPage({ viewport: { width: 940, height: 500 }, deviceScaleFactor: 1 });
  const shotDir = join(WORK, 'cli');
  mkdirSync(shotDir);
  const frames = [];
  let k = 0;
  const snap = async (n, typing, seconds) => {
    await page.setContent(html(n, typing));
    const file = join(shotDir, `f${String(k++).padStart(3, '0')}.png`);
    await page.screenshot({ path: file });
    frames.push({ file, seconds });
  };
  for (let i = 0; i < lines.length; i++) {
    const total = lines[i].cmd.length;
    const step = Math.ceil(total / 5);
    for (let c = 0; c < total; c += step) await snap(i, c, 0.18);
    await snap(i, total, 0.35);
    await snap(i, undefined, i === 1 ? 2.8 : 1.4);
  }
  await snap(lines.length, undefined, 2.2);
  await page.close();
  ffmpegGif(frames, join(OUT, 'cli.gif'), { width: 880, fps: 10 });
}

const browser = await chromium.launch();
try {
  mkdirSync(OUT, { recursive: true });
  await dashboardGif(browser);
  await cliGif(browser);
} finally {
  await browser.close();
  if (!process.env.KEEP) rmSync(WORK, { recursive: true, force: true });
  else console.log("kept " + WORK);
}
