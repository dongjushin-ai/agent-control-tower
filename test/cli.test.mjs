import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findTowerDir,
  gitCommitAndPush,
  initTower,
  logRecord,
  main,
  parseArgs,
  parseMetrics,
  runCommand,
  runSummary
} from '../bin/tower.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../bin/tower.mjs');
const NOW = Date.parse('2026-10-18T05:00:00Z');
const HOUR = 3600 * 1000;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'tower-'));
}
function cli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, TOWER_DIR: '', ...env } });
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function quiet(fn) {
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  return Promise.resolve(fn()).then(
    (v) => {
      console.log = log;
      console.error = err;
      return { value: v, out: out.join('\n') };
    },
    (e) => {
      console.log = log;
      console.error = err;
      throw e;
    }
  );
}

test('parseArgs: --key value, --key=value, repeated --metric, everything after --', () => {
  const a = parseArgs(['run', '--task', 'x', '--summary=a b', '--metric', 'n=3', '--metric', 'm=1', '--push', '--', 'ls', '-la', '--color']);
  assert.deepEqual(a._, ['run']);
  assert.equal(a.task, 'x');
  assert.equal(a.summary, 'a b');
  assert.deepEqual(a.metric, ['n=3', 'm=1']);
  assert.equal(a.push, true);
  assert.deepEqual(a.rest, ['ls', '-la', '--color']);
});

test('parseMetrics', () => {
  assert.deepEqual(parseMetrics(['added=3', 'ratio=-0.5']), { added: 3, ratio: -0.5 });
  assert.throws(() => parseMetrics(['added']), /name=number/);
  assert.throws(() => parseMetrics(['added=three']), /name=number/);
});

test('findTowerDir: --dir, TOWER_DIR, nearest parent, default', () => {
  const root = tmp();
  mkdirSync(join(root, 'tower'), { recursive: true });
  writeFileSync(join(root, 'tower', 'tower.config.json'), '{"tasks":[]}');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  assert.equal(findTowerDir(undefined, join(root, 'a', 'b'), {}), join(root, 'tower'));
  assert.equal(findTowerDir('custom', root, {}), join(root, 'custom'));
  assert.equal(findTowerDir(undefined, root, { TOWER_DIR: 'ops' }), join(root, 'ops'));
  const empty = tmp();
  assert.equal(findTowerDir(undefined, empty, {}), join(empty, 'tower'));
});

test('init creates config, logs/ and (optionally) workflows pointing at the right folder', () => {
  const root = tmp();
  git(root, 'init', '-q');
  const dir = join(root, 'ops', 'tower');
  const { config, created } = initTower(dir, { task: 'nightly-research', every: '12', name: 'Nightly', workflows: true, timezone: 'Asia/Seoul' });
  assert.equal(config.timezone, 'Asia/Seoul');
  assert.deepEqual(config.tasks, [{ id: 'nightly-research', name: 'Nightly', everyHours: 12 }]);
  assert.ok(existsSync(join(dir, 'logs', '.gitkeep')));
  const watchdog = readFileSync(join(root, '.github', 'workflows', 'tower-watchdog.yml'), 'utf8');
  const pages = readFileSync(join(root, '.github', 'workflows', 'tower-pages.yml'), 'utf8');
  assert.match(watchdog, /status --dir ops\/tower --markdown/);
  assert.match(pages, /paths: \['ops\/tower\/\*\*'\]/);
  assert.match(pages, /build --dir ops\/tower --out _site/);
  assert.equal(created.length, 4);
  // idempotent: running again keeps tasks and does not duplicate
  const again = initTower(dir, { task: 'nightly-research' });
  assert.equal(again.config.tasks.length, 1);
  assert.throws(() => initTower(dir, { task: 'Bad Id' }), /--task/);
});

test('log appends one line per run and registers new tasks', () => {
  const dir = join(tmp(), 'tower');
  initTower(dir, { timezone: 'UTC' });
  logRecord({ task: 'nightly-research', status: 'ok', summary: 'wrote 3 notes', metric: ['notes=3'], every: '6', name: 'Nightly' }, dir, NOW);
  logRecord({ task: 'nightly-research', status: 'warn', summary: '2 sources timed out', link: 'https://example.com/r/2', duration: '81' }, dir, NOW + 1000);
  const lines = readFileSync(join(dir, 'logs', 'nightly-research.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, task: 'nightly-research', at: '2026-10-18T05:00:00.000Z', status: 'ok', summary: 'wrote 3 notes', metrics: { notes: 3 } });
  assert.equal(JSON.parse(lines[1]).duration, 81);
  const config = JSON.parse(readFileSync(join(dir, 'tower.config.json'), 'utf8'));
  assert.deepEqual(config.tasks, [{ id: 'nightly-research', name: 'Nightly', everyHours: 6 }]);
});

test('log works without init (creates the config) and refuses secrets without touching files', () => {
  const dir = join(tmp(), 'tower');
  assert.throws(() => logRecord({ task: 'x', status: 'ok', summary: 'key ghp_abcdefghijklmnopqrstuvwxyz0123' }, dir, NOW), /secret/);
  assert.equal(existsSync(join(dir, 'logs', 'x.jsonl')), false);
  logRecord({ task: 'x', status: 'ok', summary: 'fine' }, dir, NOW);
  assert.ok(existsSync(join(dir, 'tower.config.json')));
});

test('CLI: log / status exit codes and output formats', () => {
  const root = tmp();
  const ok = cli(['log', '--task', 'db-backup', '--status', 'ok', '--summary', 'exit 0 in 41s', '--every', '1', '--at', '2026-10-18T04:30:00Z'], root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /recorded tower\/logs\/db-backup\.jsonl/);
  assert.match(ok.stdout, /added new task "db-backup"/);
  const bad = cli(['log', '--task', 'db-backup', '--status', 'great', '--summary', 'x'], root);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /status must be ok, warn or fail/);

  const healthy = cli(['status', '--now', '2026-10-18T05:00:00Z'], root);
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /\[ OK \] db-backup/);

  const silent = cli(['status', '--now', '2026-10-18T08:00:00Z', '--json'], root);
  assert.equal(silent.status, 2);
  const json = JSON.parse(silent.stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(json.failing, ['db-backup']);
  assert.equal(json.tasks[0].state, 'stale');

  const md = cli(['status', '--now', '2026-10-18T08:00:00Z', '--markdown', '--lang', 'ko'], root);
  assert.equal(md.status, 2);
  assert.match(md.stdout, /\| 작업 \| 상태 \|/);

  const lenient = cli(['status', '--now', '2026-10-18T08:00:00Z', '--fail-on', 'fail'], root);
  assert.equal(lenient.status, 0);

  const missing = cli(['status'], tmp());
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /run `npx agent-control-tower init`/);
});

test('CLI: status reports unreadable lines instead of crashing', () => {
  const root = tmp();
  cli(['log', '--task', 'a', '--status', 'ok', '--summary', 'fine'], root);
  writeFileSync(join(root, 'tower', 'logs', 'a.jsonl'), readFileSync(join(root, 'tower', 'logs', 'a.jsonl'), 'utf8') + '{oops\n');
  const r = cli(['status'], root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /a\.jsonl line 2: not valid JSON/);
});

test('CLI: help, version, unknown command', () => {
  const root = tmp();
  assert.match(cli(['help'], root).stdout, /Usage: npx agent-control-tower/);
  assert.equal(cli([], root).status, 1);
  assert.match(cli(['--version'], root).stdout, /^\d+\.\d+\.\d+/);
  assert.equal(cli(['frobnicate'], root).status, 1);
});

test('build writes a self-contained static site', () => {
  const root = tmp();
  cli(['log', '--task', 'a', '--status', 'ok', '--summary', 'visible', '--link', 'https://example.com/a'], root);
  const r = cli(['build', '--out', 'site'], root);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['index.html', 'tower-core.js', 'summary.json', '.nojekyll']) assert.ok(existsSync(join(root, 'site', f)), f);
  const s = JSON.parse(readFileSync(join(root, 'site', 'summary.json'), 'utf8'));
  assert.equal(s.records.a[0].summary, 'visible');
  const red = cli(['build', '--out', 'site2', '--redact'], root);
  assert.equal(red.status, 0);
  const text = readFileSync(join(root, 'site2', 'summary.json'), 'utf8');
  assert.equal(text.includes('visible'), false);
  assert.equal(text.includes('example.com'), false);
});

test('run records ok/fail from the exit code and passes the code through', async () => {
  const root = tmp();
  const okRun = cli(['run', '--task', 'job', '--', process.execPath, '-e', 'console.log("hello")'], root);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.match(okRun.stdout, /hello/);
  const failRun = cli(['run', '--task', 'job', '--', process.execPath, '-e', 'console.error("boom: disk full"); process.exit(3)'], root);
  assert.equal(failRun.status, 3);
  const lines = readFileSync(join(root, 'tower', 'logs', 'job.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].status, 'ok');
  assert.match(lines[0].summary, /^exit 0 in \d/);
  assert.equal(typeof lines[0].duration, 'number');
  assert.equal(lines[1].status, 'fail');
  assert.match(lines[1].summary, /^exit 3 in .*: boom: disk full$/);

  const notFound = cli(['run', '--task', 'job', '--', 'definitely-not-a-command-xyz'], root);
  assert.equal(notFound.status, 127);
  assert.match(readFileSync(join(root, 'tower', 'logs', 'job.jsonl'), 'utf8'), /could not start: ENOENT/);

  assert.equal(cli(['run', '--task', 'job'], root).status, 1);
  assert.equal(cli(['run', '--', 'ls'], root).status, 1);
});

test('runSummary hides a secret-looking last line and keeps custom success text', () => {
  assert.equal(runSummary({ code: 0, seconds: 1.234, tail: '' }, 'Backup uploaded'), 'Backup uploaded');
  assert.equal(runSummary({ code: 0, seconds: 61, tail: 'done' }, ''), 'exit 0 in 61s');
  assert.match(runSummary({ code: 1, seconds: 2, tail: 'auth failed for ghp_abcdefghijklmnopqrstuvwxyz0123' }, ''), /hidden: looked like a secret/);
  assert.equal(runSummary({ code: null, signal: 'SIGTERM', seconds: 5, tail: '' }, ''), 'killed by SIGTERM after 5.0s');
});

test('runCommand captures the last output line', async () => {
  const r = await runCommand([process.execPath, '-e', 'console.log("a\\nlast line")'], { inherit: false });
  assert.equal(r.code, 0);
  assert.equal(r.tail, 'last line');
});

test('log --push commits and pushes, rebasing when another agent pushed first', () => {
  const base = tmp();
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const a = join(base, 'a');
  const b = join(base, 'b');
  git(base, 'clone', '-q', remote, a);
  git(a, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root');
  git(a, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', remote, b);

  // agent A logs task-a (no git identity configured: falls back to the bot identity)
  const ra = cli(['log', '--task', 'task-a', '--status', 'ok', '--summary', 'from a', '--push'], a, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(ra.status, 0, ra.stderr);
  // agent B has a stale clone and logs task-b: push is rejected once, then rebased and retried
  const rb = cli(['log', '--task', 'task-b', '--status', 'warn', '--summary', 'from b', '--every', '6', '--push'], b, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(rb.status === 0 || rb.status === 3, true, rb.stderr);

  const check = join(base, 'check');
  git(base, 'clone', '-q', remote, check);
  const subjects = git(check, 'log', '--format=%s %an');
  assert.match(subjects, /tower: task-a ok agent-control-tower/);
  assert.ok(existsSync(join(check, 'tower', 'logs', 'task-a.jsonl')));
  if (rb.status === 0) {
    // both agents created tower.config.json: rebase conflicts on it are possible, so only assert when B succeeded
    assert.ok(existsSync(join(check, 'tower', 'logs', 'task-b.jsonl')));
    assert.match(subjects, /tower: task-b warn/);
  }
});

test('log --push after init: the common case rebases cleanly', () => {
  const base = tmp();
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = join(base, 'seed');
  git(base, 'clone', '-q', remote, seed);
  git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  initTower(join(seed, 'tower'), { timezone: 'UTC', task: 'task-a' });
  initTower(join(seed, 'tower'), { task: 'task-b' });
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init tower');
  git(seed, 'push', '-q', 'origin', 'main');
  const a = join(base, 'a');
  const b = join(base, 'b');
  git(base, 'clone', '-q', remote, a);
  git(base, 'clone', '-q', remote, b);
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  assert.equal(cli(['log', '--task', 'task-a', '--status', 'ok', '--summary', 'a1', '--push'], a, env).status, 0);
  const rb = cli(['log', '--task', 'task-b', '--status', 'ok', '--summary', 'b1', '--push'], b, env);
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.match(rb.stdout, /pushed \(attempt 2\)/);
  const check = join(base, 'check');
  git(base, 'clone', '-q', remote, check);
  assert.ok(existsSync(join(check, 'tower', 'logs', 'task-a.jsonl')));
  assert.ok(existsSync(join(check, 'tower', 'logs', 'task-b.jsonl')));
});

test('gitCommitAndPush refuses outside a repository', () => {
  const dir = join(tmp(), 'tower');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f'), 'x');
  assert.throws(() => gitCommitAndPush(dir, [join(dir, 'f')], 'm'), /not inside a git repository/);
});

test('main() can be called in-process', async () => {
  const root = tmp();
  const { value, out } = await quiet(() => main(['log', '--task', 'inproc', '--status', 'ok', '--summary', 'hi'], { cwd: root, env: {}, now: NOW }));
  assert.equal(value, 0);
  assert.match(out, /recorded/);
  const { value: code } = await quiet(() => main(['status'], { cwd: root, env: {}, now: NOW + 40 * HOUR }));
  assert.equal(code, 2);
});

test('serve: dashboard, core and a fresh summary.json (404 before init)', async () => {
  const { spawn } = await import('node:child_process');
  const root = tmp();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], { cwd: root, env: { ...process.env, TOWER_DIR: '' } });
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => {
    for (let i = 0; i < 50; i++) {
      try {
        return await fetch(base + p);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('server did not start');
  };
  try {
    assert.equal((await get('/')).status, 200);
    assert.equal((await get('/tower-core.js')).status, 200);
    assert.equal((await get('/summary.json')).status, 404);
    assert.equal((await get('/../etc/passwd')).status, 404);
    cli(['log', '--task', 'live', '--status', 'ok', '--summary', 'served'], root);
    const s = await (await get('/summary.json')).json();
    assert.equal(s.records.live[0].summary, 'served');
  } finally {
    child.kill();
  }
});
