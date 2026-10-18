#!/usr/bin/env node
// agent-control-tower CLI — Node 20+, no dependencies.
// Run `npx agent-control-tower help` for usage.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('../dashboard/tower-core.js');

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'tower';
const BOT_NAME = 'agent-control-tower';
const BOT_EMAIL = 'agent-control-tower@users.noreply.github.com';

const HELP = `agent-control-tower ${core.VERSION} — a dead-man's switch and dashboard for unattended agents

Usage: npx agent-control-tower <command> [options]

  init      Create tower/tower.config.json and tower/logs/ in this repo
            --task <id> --name <name> --every <hours>   add a first task
            --workflows                                  also add GitHub Actions (Pages + watchdog)
  log       Append one record:  --task <id> --status ok|warn|fail --summary "<one line>"
            [--link <url>] [--metric name=number ...] [--duration <sec>]
            [--name <name> --every <hours>]   (used when the task is new)
            [--push]                          git add + commit + push (rebases and retries)
  run       Run a command and record the result:  run --task <id> [--push] -- <command...>
            exit 0 -> ok, anything else -> fail. Exits with the command's exit code.
  status    Show every task. Exit 2 if any task is failing or silent.
            [--json | --markdown] [--fail-on fail,stale,warn,none] [--lang en|ko] [--offline]
  build     Write a static dashboard: --out <dir> (default _site) [--days 14] [--redact]
  serve     Serve the dashboard for this repo locally: [--port 8787]

Common: --dir <path> (default: ./tower, or the nearest parent with tower/tower.config.json; env TOWER_DIR)
Docs: https://github.com/dongjushin-ai/agent-control-tower`;

// ------------------------------------------------------------------ args
export function parseArgs(argv) {
  const args = { _: [], metric: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.rest = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let key, val;
    if (eq > -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) val = true;
      else {
        val = next;
        i++;
      }
    }
    if (key === 'metric') args.metric.push(val);
    else args[key] = val;
  }
  return args;
}

export function parseMetrics(list) {
  const metrics = {};
  for (const item of list || []) {
    const m = /^([A-Za-z0-9_.-]{1,40})=(-?\d+(?:\.\d+)?)$/.exec(String(item));
    if (!m) throw new Error(`--metric must be name=number (got: ${item})`);
    metrics[m[1]] = Number(m[2]);
  }
  return metrics;
}

// ----------------------------------------------------------------- paths
/** Find the tower directory: --dir, $TOWER_DIR, nearest parent containing tower/tower.config.json, else ./tower */
export function findTowerDir(opt, cwd = process.cwd(), env = process.env) {
  if (opt && opt !== true) return resolve(cwd, opt);
  if (env.TOWER_DIR) return resolve(cwd, env.TOWER_DIR);
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, DEFAULT_DIR, 'tower.config.json'))) return join(dir, DEFAULT_DIR);
    if (existsSync(join(dir, 'tower.config.json')) && existsSync(join(dir, 'logs'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(cwd, DEFAULT_DIR);
}

function configPath(dir) {
  return join(dir, 'tower.config.json');
}
function logsDir(dir) {
  return join(dir, 'logs');
}

export function readConfig(dir) {
  const file = configPath(dir);
  if (!existsSync(file)) throw new Error(`no tower.config.json in ${dir} — run \`npx agent-control-tower init\` first`);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message})`);
  }
  const res = core.validateConfig(config);
  if (!res.ok) throw new Error(`${file}:\n- ${res.errors.join('\n- ')}`);
  return config;
}

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function taskFromArgs(id, opts) {
  const task = { id, name: opts.name && opts.name !== true ? String(opts.name) : id, everyHours: Number(opts.every) > 0 ? Number(opts.every) : 24 };
  if (opts.kind && opts.kind !== true) task.kind = String(opts.kind);
  if (opts.schedule && opts.schedule !== true) task.schedule = String(opts.schedule);
  return task;
}

// ------------------------------------------------------------------ init
export function initTower(dir, opts = {}) {
  const created = [];
  mkdirSync(logsDir(dir), { recursive: true });
  const keep = join(logsDir(dir), '.gitkeep');
  if (!existsSync(keep)) {
    writeFileSync(keep, '');
    created.push(keep);
  }
  let config;
  if (existsSync(configPath(dir))) config = readConfig(dir);
  else {
    config = { version: 1, title: 'Agent Control Tower', timezone: opts.timezone || defaultTimezone(), tasks: [] };
    created.push(configPath(dir));
  }
  if (opts.task && opts.task !== true) {
    const id = String(opts.task);
    if (!core.TASK_ID_RE.test(id)) throw new Error('--task must be lowercase letters, digits and dashes (e.g. nightly-research)');
    if (!config.tasks.some((t) => t.id === id)) config.tasks.push(taskFromArgs(id, opts));
  }
  writeJson(configPath(dir), config);

  if (opts.workflows) {
    const repoRoot = gitTop(dir) || process.cwd();
    const wfDir = join(repoRoot, '.github', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    const towerRel = relative(repoRoot, dir).split('\\').join('/') || '.';
    for (const name of readdirSync(join(PKG_ROOT, 'templates', 'workflows'))) {
      const target = join(wfDir, name);
      if (existsSync(target) && !opts.force) continue;
      const text = readFileSync(join(PKG_ROOT, 'templates', 'workflows', name), 'utf8')
        .replace(/--dir tower\b/g, `--dir ${towerRel}`)
        .replace(/'tower\/\*\*'/g, towerRel === '.' ? "'**'" : `'${towerRel}/**'`);
      writeFileSync(target, text);
      created.push(target);
    }
  }
  return { config, created };
}

// ------------------------------------------------------------------- log
/** Append one record. Returns { record, file, addedToConfig }. Throws with a readable message. */
export function logRecord(opts, dir, now = Date.now()) {
  const rec = core.makeRecord(
    {
      task: opts.task,
      status: opts.status,
      summary: opts.summary === true ? '' : opts.summary,
      link: opts.link === true ? '' : opts.link,
      at: opts.at === true ? undefined : opts.at,
      duration: opts.duration === true ? undefined : opts.duration,
      metrics: parseMetrics(opts.metric)
    },
    now
  );
  const res = core.validateRecord(rec);
  if (!res.ok) throw new Error(res.errors.join('\n'));

  let addedToConfig = false;
  let config = null;
  if (existsSync(configPath(dir))) config = readConfig(dir);
  else config = { version: 1, title: 'Agent Control Tower', timezone: defaultTimezone(), tasks: [] };
  if (!config.tasks.some((t) => t.id === rec.task)) {
    config.tasks.push(taskFromArgs(rec.task, opts));
    addedToConfig = true;
  }
  mkdirSync(logsDir(dir), { recursive: true });
  const file = join(logsDir(dir), `${rec.task}.jsonl`);
  appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
  if (addedToConfig || !existsSync(configPath(dir))) writeJson(configPath(dir), config);
  return { record: rec, file, addedToConfig };
}

// ------------------------------------------------------------------- git
function git(cwd, args, extraEnv) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
}
function gitTop(dir) {
  const r = git(existsSync(dir) ? dir : dirname(dir), ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** git add + commit + push, rebasing and retrying when the remote moved. Never force-pushes. */
export function gitCommitAndPush(dir, files, message, { retries = 3, remote = 'origin' } = {}) {
  const top = gitTop(dir);
  if (!top) throw new Error(`${dir} is not inside a git repository`);
  const add = git(top, ['add', '--', ...files]);
  if (add.status !== 0) throw new Error('git add failed: ' + add.stderr.trim());
  const hasIdentity = git(top, ['config', 'user.email']).stdout.trim() !== '';
  const id = hasIdentity ? [] : ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`];
  const commit = git(top, [...id, 'commit', '--no-verify', '-m', message, '--', ...files]);
  if (commit.status !== 0) throw new Error('git commit failed: ' + (commit.stderr || commit.stdout).trim());
  const branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  let lastErr = '';
  for (let i = 0; i <= retries; i++) {
    const push = git(top, ['push', remote, `HEAD:${branch}`]);
    if (push.status === 0) return { pushed: true, attempts: i + 1 };
    lastErr = push.stderr.trim();
    const pull = git(top, [...id, 'pull', '--rebase', '--no-edit', remote, branch], { GIT_EDITOR: 'true' });
    if (pull.status !== 0) {
      git(top, ['rebase', '--abort']);
      throw new Error('push rejected and rebase failed; the record is committed locally. ' + pull.stderr.trim());
    }
  }
  throw new Error(`push failed after ${retries + 1} attempts: ${lastErr}`);
}

// ------------------------------------------------------------------- run
const tail = (s, n) => {
  const lines = String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return last.length > n ? last.slice(0, n - 1) + '…' : last;
};

export function runCommand(cmd, { inherit = true } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let out = '';
    let err = '';
    const keep = (s, chunk) => (s + chunk).slice(-4000);
    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolvePromise({ code: 127, seconds: 0, tail: `could not start: ${e.message}` });
      return;
    }
    child.stdout.on('data', (c) => {
      out = keep(out, c.toString());
      if (inherit) process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      err = keep(err, c.toString());
      if (inherit) process.stderr.write(c);
    });
    child.on('error', (e) => resolvePromise({ code: 127, seconds: (Date.now() - started) / 1000, tail: `could not start: ${e.code || e.message}` }));
    child.on('close', (code, signal) => {
      const seconds = (Date.now() - started) / 1000;
      resolvePromise({ code: code === null ? 128 : code, signal, seconds, tail: tail(err, 140) || tail(out, 140) });
    });
  });
}

export function runSummary(result, given) {
  const secs = result.seconds < 10 ? result.seconds.toFixed(1) : Math.round(result.seconds);
  const base = result.signal ? `killed by ${result.signal} after ${secs}s` : `exit ${result.code} in ${secs}s`;
  if (result.code === 0 && given) return given;
  let t = result.code === 0 ? '' : result.tail;
  if (t && core.findSecrets(t).length) t = '(last output line hidden: looked like a secret)';
  return t ? `${base}: ${t}` : base;
}

// ---------------------------------------------------------------- status
export async function loadAll(dir, { offline = false, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig(dir);
  const byTask = {};
  const notes = [];
  for (const t of config.tasks) {
    let text = '';
    if (t.source && t.source.url) {
      if (offline) {
        notes.push(`${t.id}: remote source skipped (--offline)`);
        byTask[t.id] = [];
        continue;
      }
      try {
        const res = await fetchImpl(t.source.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } catch (e) {
        notes.push(`${t.id}: could not read ${t.source.url} (${e.message})`);
      }
    } else {
      const file = join(logsDir(dir), `${t.id}.jsonl`);
      if (existsSync(file)) text = readFileSync(file, 'utf8');
    }
    const parsed = core.parseJsonl(text, t.id);
    parsed.errors.forEach((e) => notes.push(`${t.id}.jsonl line ${e.line}: ${e.message}`));
    byTask[t.id] = parsed.records;
  }
  return { config, byTask, notes };
}

// ----------------------------------------------------------------- build
export function writeSite(outDir, summary) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(PKG_ROOT, 'dashboard', 'index.html'), join(outDir, 'index.html'));
  copyFileSync(join(PKG_ROOT, 'dashboard', 'tower-core.js'), join(outDir, 'tower-core.js'));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary) + '\n');
  writeFileSync(join(outDir, '.nojekyll'), '');
}

// ----------------------------------------------------------------- serve
function serve(dir, port) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/tower-core.js': ['tower-core.js', 'text/javascript; charset=utf-8']
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (path === '/summary.json') {
        if (!existsSync(configPath(dir))) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('no tower.config.json in ' + dir);
          return;
        }
        const { config, byTask } = await loadAll(dir);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(core.buildSummary(config, byTask, { days: 30 })));
        return;
      }
      const f = files[path];
      if (!f) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
      res.end(readFileSync(join(PKG_ROOT, 'dashboard', f[0])));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e.message));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dashboard for ${dir}\n  http://127.0.0.1:${port}/   demo: http://127.0.0.1:${port}/?demo   (Ctrl+C to stop)`);
  });
  return server;
}

// ------------------------------------------------------------------ main
const STATUS_HINT = 'status must be ok, warn or fail';

export async function main(argv, { cwd = process.cwd(), env = process.env, now } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === 'version' || args.version) {
    console.log(core.VERSION);
    return 0;
  }
  if (!cmd || cmd === 'help' || args.help) {
    console.log(HELP);
    return cmd || args.help ? 0 : 1;
  }
  const dir = findTowerDir(args.dir, cwd, env);

  if (cmd === 'init') {
    try {
      const { config, created } = initTower(dir, args);
      created.forEach((f) => console.log('created ' + relative(cwd, f)));
      console.log(`\nTower ready in ${relative(cwd, dir) || '.'} (${config.tasks.length} task${config.tasks.length === 1 ? '' : 's'}, timezone ${config.timezone}).`);
      const id = config.tasks[0] ? config.tasks[0].id : 'my-agent';
      console.log(`\nNext:
  1. Record a run:   npx agent-control-tower log --task ${id} --status ok --summary "first run" --push
  2. Paste a snippet at the end of your agent's prompt:
     https://github.com/dongjushin-ai/agent-control-tower/tree/main/snippets
  3. See it:         npx agent-control-tower status   |   npx agent-control-tower serve`);
      return 0;
    } catch (e) {
      console.error('init failed: ' + e.message);
      return 1;
    }
  }

  if (cmd === 'log') {
    if (!['ok', 'warn', 'fail'].includes(args.status)) {
      console.error('log failed: ' + STATUS_HINT);
      return 1;
    }
    let result;
    try {
      result = logRecord(args, dir, now);
    } catch (e) {
      console.error('log failed:\n' + e.message);
      return 1;
    }
    console.log(`recorded ${relative(cwd, result.file)} <- ${result.record.status} · ${result.record.summary}`);
    if (result.addedToConfig) console.log(`added new task "${result.record.task}" to tower.config.json (every ${Number(args.every) || 24}h)`);
    if (args.push) {
      try {
        const p = gitCommitAndPush(dir, [result.file, configPath(dir)], `tower: ${result.record.task} ${result.record.status}`);
        console.log(`pushed (attempt ${p.attempts})`);
      } catch (e) {
        console.error('push failed: ' + e.message);
        return 3;
      }
    }
    return 0;
  }

  if (cmd === 'run') {
    if (!args.rest.length) {
      console.error('run: put the command after --, e.g. run --task backup -- ./backup.sh');
      return 1;
    }
    if (!args.task || !core.TASK_ID_RE.test(String(args.task))) {
      console.error('run: --task <id> is required (lowercase letters, digits, dashes)');
      return 1;
    }
    const result = await runCommand(args.rest);
    const status = result.code === 0 ? 'ok' : 'fail';
    const summary = runSummary(result, typeof args.summary === 'string' ? args.summary : '');
    try {
      const r = logRecord({ ...args, status, summary, duration: Math.round(result.seconds * 10) / 10 }, dir, now);
      console.error(`[tower] recorded ${r.record.task} <- ${status} · ${summary}`);
      if (args.push) gitCommitAndPush(dir, [r.file, configPath(dir)], `tower: ${r.record.task} ${status}`);
    } catch (e) {
      console.error('[tower] could not record: ' + e.message);
    }
    return result.code;
  }

  if (cmd === 'status') {
    let data;
    try {
      data = await loadAll(dir, { offline: Boolean(args.offline) });
    } catch (e) {
      console.error(e.message);
      return 1;
    }
    const t = args.now && args.now !== true ? Date.parse(args.now) : now ?? Date.now();
    const overview = core.computeOverview(data.config, data.byTask, t, { lang: args.lang });
    const failOn = args['fail-on'] && args['fail-on'] !== true ? String(args['fail-on']).split(',').map((s) => s.trim()) : ['fail', 'stale'];
    const failing = core.failingTasks(overview, failOn);
    if (args.json) {
      console.log(JSON.stringify({ ok: failing.length === 0, failing: failing.map((v) => v.id), issues: overview.issues, tasks: overview.tasks.map((v) => ({ id: v.id, name: v.name, state: v.state, lastAt: v.lastAt ? new Date(v.lastAt).toISOString() : null, last: v.last, week: v.week })), notes: data.notes }, null, 2));
    } else if (args.markdown) {
      console.log(core.renderMarkdown(overview));
      if (data.notes.length) console.log('\n<details><summary>Notes</summary>\n\n- ' + data.notes.join('\n- ') + '\n</details>');
    } else {
      console.log(core.renderText(overview));
      if (data.notes.length) console.log('\nnotes:\n- ' + data.notes.join('\n- '));
    }
    return failing.length ? 2 : 0;
  }

  if (cmd === 'build') {
    try {
      const data = await loadAll(dir, { offline: Boolean(args.offline) });
      const out = resolve(cwd, args.out && args.out !== true ? args.out : '_site');
      const summary = core.buildSummary(data.config, data.byTask, { now: now ?? Date.now(), days: Number(args.days) || 14, redact: Boolean(args.redact) });
      writeSite(out, summary);
      const n = Object.values(summary.records).reduce((a, l) => a + l.length, 0);
      console.log(`wrote ${relative(cwd, out) || '.'}/ (index.html, tower-core.js, summary.json: ${summary.config.tasks.length} tasks, ${n} records${args.redact ? ', redacted' : ''})`);
      data.notes.forEach((n2) => console.log('note: ' + n2));
      return 0;
    } catch (e) {
      console.error('build failed: ' + e.message);
      return 1;
    }
  }

  if (cmd === 'serve') {
    if (existsSync(configPath(dir))) {
      try {
        readConfig(dir);
      } catch (e) {
        console.error(e.message);
        return 1;
      }
    } else console.log(`No tower.config.json in ${dir} yet: the page will offer the demo (add ?demo to the URL).`);
    serve(dir, Number(args.port) || 8787);
    return new Promise(() => {}); // keep running
  }

  console.error(`unknown command "${cmd}"\n\n${HELP}`);
  return 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
