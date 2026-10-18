'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../dashboard/tower-core.js');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-18T05:00:00Z'); // Sun 14:00 in Seoul, Sat 22:00 Oct 17 in Los Angeles

function rec(over) {
  return Object.assign({ v: 1, task: 'nightly-research', at: '2026-10-18T02:00:00Z', status: 'ok', summary: 'wrote 3 notes' }, over);
}
function task(over) {
  return Object.assign({ id: 'nightly-research', name: 'Nightly research', everyHours: 24 }, over);
}
function hoursAgo(h, status, over) {
  return rec(Object.assign({ at: new Date(NOW - h * HOUR).toISOString(), status: status || 'ok' }, over));
}

// ------------------------------------------------------------ records
test('valid records pass', () => {
  assert.deepEqual(C.validateRecord(rec()), { ok: true, errors: [] });
  assert.equal(C.validateRecord(rec({ link: 'https://example.com/run/1', metrics: { notes: 3 }, duration: 12.5 })).ok, true);
  assert.equal(C.validateRecord(rec({ at: '2026-10-18T11:00:00+09:00' })).ok, true);
});

test('invalid records are rejected with a reason', () => {
  const cases = [
    [{ task: 'Nightly Research' }, 'task'],
    [{ status: 'success' }, 'status'],
    [{ at: 'yesterday' }, 'at'],
    [{ summary: '  ' }, 'summary is empty'],
    [{ summary: 'two\nlines' }, 'single line'],
    [{ summary: 'x'.repeat(301) }, '300'],
    [{ link: 'example.com/x' }, 'link'],
    [{ link: 'javascript:alert(1)' }, 'link'],
    [{ metrics: { notes: '3' } }, 'metrics.notes'],
    [{ metrics: { 'bad name!': 1 } }, 'metric name'],
    [{ duration: -1 }, 'duration'],
    [{ v: 2 }, 'v must']
  ];
  for (const [over, needle] of cases) {
    const res = C.validateRecord(rec(over));
    assert.equal(res.ok, false, JSON.stringify(over));
    assert.ok(res.errors.some((e) => e.includes(needle)), `${JSON.stringify(over)} -> ${res.errors}`);
  }
  assert.equal(C.validateRecord(null).ok, false);
  assert.equal(C.validateRecord([]).ok, false);
});

test('anything that looks like a secret is refused', () => {
  const secrets = [
    'sk-ant-api03-abcdefghijklmnopqrstuv',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0123456789_abcdef',
    'xoxb-1234567890-abcdefghij',
    'AKIAABCDEFGHIJKLMNOP',
    'sk_live_abcdefghijklmnop1234',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'password: hunter2',
    'postgres://admin:hunter2@db.internal:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----'
  ];
  for (const s of secrets) {
    const res = C.validateRecord(rec({ summary: 'result ' + s }));
    assert.equal(res.ok, false, s);
    assert.ok(res.errors.some((e) => e.includes('secret')), s);
  }
  assert.equal(C.validateRecord(rec({ link: 'https://x.test/?token=ghp_abcdefghijklmnopqrstuvwxyz0123' })).ok, false);
  assert.deepEqual(C.findSecrets('Reset password reminder added; sk hynix report; 3 tasks'), []);
  assert.deepEqual(C.findSecrets('https://github.com/owner/repo/actions/runs/123'), []);
});

test('makeRecord fills the time and squashes whitespace', () => {
  const r = C.makeRecord({ task: 'a', status: 'ok', summary: '  several\n  lines  ', metrics: {} }, NOW);
  assert.equal(r.at, '2026-10-18T05:00:00.000Z');
  assert.equal(r.summary, 'several lines');
  assert.equal(r.v, 1);
  assert.equal('metrics' in r, false);
  assert.equal('link' in r, false);
  assert.equal('duration' in r, false);
  assert.equal(C.makeRecord({ task: 'a', status: 'ok', summary: 'x', duration: '4.5' }, NOW).duration, 4.5);
});

test('parseJsonl skips broken lines and reports line numbers', () => {
  const text = [JSON.stringify(rec()), '', '{broken', JSON.stringify(rec({ status: 'nope' })), JSON.stringify(rec({ task: 'other' })), JSON.stringify(rec({ status: 'fail', summary: 'x' }))].join('\n');
  const { records, errors } = C.parseJsonl(text, 'nightly-research');
  assert.equal(records.length, 2);
  assert.deepEqual(errors.map((e) => e.line), [3, 4, 5]);
  assert.match(errors[2].message, /does not match file name/);
  assert.deepEqual(C.parseJsonl('', 'x'), { records: [], errors: [] });
  assert.deepEqual(C.parseJsonl('\r\n' + JSON.stringify(rec()) + '\r\n').records.length, 1);
});

// ------------------------------------------------------------- config
test('validateConfig catches common mistakes', () => {
  assert.equal(C.validateConfig({ tasks: [task()] }).ok, true);
  assert.equal(C.validateConfig({ timezone: 'Asia/Seoul', tasks: [] }).ok, true);
  const bad = C.validateConfig({
    timezone: 'Mars/Olympus',
    tasks: [task(), task(), { id: 'Bad Id' }, { id: 'x', everyHours: 0 }, { id: 'y', source: { url: 'ftp://x' } }, { id: 'z', link: 'nope' }]
  });
  assert.equal(bad.ok, false);
  const all = bad.errors.join('\n');
  for (const needle of ['timezone', 'duplicate', 'tasks[2].id', 'everyHours', 'source.url', 'link']) assert.ok(all.includes(needle), needle);
  assert.equal(C.validateConfig(null).ok, false);
  assert.equal(C.validateConfig({}).ok, false);
});

// -------------------------------------------------------------- state
test('staleAfterMs: schedule + max(1h, half the schedule), or graceHours', () => {
  assert.equal(C.staleAfterMs({ everyHours: 24 }), 36 * HOUR);
  assert.equal(C.staleAfterMs({ everyHours: 1 }), 2 * HOUR);
  assert.equal(C.staleAfterMs({ everyHours: 0.5 }), 1.5 * HOUR);
  assert.equal(C.staleAfterMs({ everyHours: 6, graceHours: 0 }), 6 * HOUR);
  assert.equal(C.staleAfterMs({}), 36 * HOUR);
});

test('state: ok, warn, fail, stale, none, paused', () => {
  const v = (records, over) => C.computeTaskView(task(over), records, NOW, { timezone: 'UTC' }).state;
  assert.equal(v([hoursAgo(3)]), 'ok');
  assert.equal(v([hoursAgo(3, 'warn')]), 'warn');
  assert.equal(v([hoursAgo(3, 'fail'), hoursAgo(27)]), 'fail');
  assert.equal(v([hoursAgo(37)]), 'stale');
  assert.equal(v([hoursAgo(35)]), 'ok');
  assert.equal(v([hoursAgo(50, 'fail')]), 'fail', 'a failure stays a failure even when old');
  assert.equal(v([]), 'none');
  assert.equal(v([hoursAgo(3)], { enabled: false }), 'paused');
  assert.equal(v([hoursAgo(7)], { everyHours: 4, graceHours: 2 }), 'stale');
});

test('the newest record wins, regardless of file order; future records are ignored', () => {
  const view = C.computeTaskView(task(), [hoursAgo(30, 'fail'), hoursAgo(2, 'ok'), hoursAgo(-3, 'fail')], NOW, { timezone: 'UTC' });
  assert.equal(view.state, 'ok');
  assert.equal(view.recent.length, 2);
  assert.equal(view.lastAgoMs, 2 * HOUR);
});

test('silentForMs is set only when stale', () => {
  const stale = C.computeTaskView(task(), [hoursAgo(64)], NOW);
  assert.equal(stale.silentForMs, 64 * HOUR);
  assert.equal(C.computeTaskView(task(), [hoursAgo(3)], NOW).silentForMs, null);
});

test('7-day strip uses calendar days in the configured time zone', () => {
  // 2026-10-17T20:00Z is Oct 18 05:00 in Seoul, but Oct 17 13:00 in Los Angeles
  const records = [rec({ at: '2026-10-17T20:00:00Z' })];
  const seoul = C.computeTaskView(task(), records, NOW, { timezone: 'Asia/Seoul' });
  const la = C.computeTaskView(task(), records, NOW, { timezone: 'America/Los_Angeles' });
  assert.equal(seoul.days[6].key, '2026-10-18');
  assert.equal(seoul.days[6].isToday, true);
  assert.equal(seoul.days[6].total, 1);
  assert.equal(la.days[6].key, '2026-10-17');
  assert.equal(la.days[6].total, 1);
  assert.equal(seoul.days[0].key, '2026-10-12');
  assert.equal(seoul.days.length, 7);
});

test('7-day strip survives a DST change (no skipped or doubled days)', () => {
  // US DST ends 2026-11-01. "Now" is just after local midnight on Nov 2.
  const now = Date.parse('2026-11-02T05:30:00Z'); // 00:30 EST
  const view = C.computeTaskView(task(), [], now, { timezone: 'America/New_York' });
  assert.deepEqual(view.days.map((d) => d.key), ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('week stats: success rate, per-day fill and coverage', () => {
  const hourly = task({ id: 'db-backup', everyHours: 1 });
  const records = [];
  for (let h = 1; h <= 24; h++) records.push(rec({ task: 'db-backup', at: new Date(NOW - h * HOUR).toISOString(), status: h === 5 ? 'fail' : 'ok' }));
  const view = C.computeTaskView(hourly, records, NOW, { timezone: 'UTC' });
  assert.equal(view.week.total, 24);
  assert.equal(view.week.ok, 23);
  assert.ok(Math.abs(view.week.rate - 23 / 24) < 1e-9);
  assert.equal(view.perDay, 24);
  // a task that started 24 hours ago is not punished for the six days before it existed
  assert.ok(view.week.coverage > 0.9, String(view.week.coverage));
  const daily = C.computeTaskView(task(), [hoursAgo(2)], NOW, { timezone: 'UTC' });
  assert.equal(daily.days[6].fill, 1);
  assert.equal(daily.week.coverage, 1);
  assert.equal(C.computeTaskView(task({ enabled: false }), [], NOW).week.coverage, null);
});

test('overview: worst first, counts, problems, failingTasks', () => {
  const config = {
    tasks: [task({ id: 'a', name: 'A' }), task({ id: 'b', name: 'B' }), task({ id: 'c', name: 'C' }), task({ id: 'd', name: 'D', enabled: false }), task({ id: 'e', name: 'E' })]
  };
  const byTask = {
    a: [hoursAgo(2, 'ok', { task: 'a' })],
    b: [hoursAgo(40, 'ok', { task: 'b' })],
    c: [hoursAgo(1, 'fail', { task: 'c' })],
    e: [hoursAgo(1, 'warn', { task: 'e' })]
  };
  const ov = C.computeOverview(config, byTask, NOW, { timezone: 'UTC' });
  assert.deepEqual(ov.tasks.map((t) => t.state), ['fail', 'stale', 'warn', 'ok', 'paused']);
  assert.deepEqual(ov.counts, { ok: 1, warn: 1, fail: 1, stale: 1, none: 0, paused: 1 });
  assert.deepEqual(ov.problems.map((p) => p.id), ['c', 'b']);
  assert.match(ov.problems[1].message, /no record for 40h/);
  assert.equal(ov.weekRate, 2 / 4); // a ok, b ok (old but inside 7 days), c fail, e warn
  assert.deepEqual(C.failingTasks(ov).map((t) => t.id), ['c', 'b']);
  assert.deepEqual(C.failingTasks(ov, ['warn']).map((t) => t.id), ['e']);
});

test('Korean labels', () => {
  const ov = C.computeOverview({ tasks: [task({ name: '리서치' })] }, { 'nightly-research': [hoursAgo(40)] }, NOW, { lang: 'ko', timezone: 'Asia/Seoul' });
  assert.match(ov.problems[0].message, /리서치: 40시간째 기록이 없어요/);
  assert.match(C.renderText(ov), /에이전트 관제탑/);
  assert.equal(C.formatAgo(3 * DAY + 2 * HOUR, 'ko'), '3일 2시간 전');
  assert.equal(C.formatAgo(30 * 60000, 'en'), '30m ago');
  assert.equal(C.lang('ko-KR'), 'ko');
  assert.equal(C.lang('fr'), 'en');
});

test('renderText and renderMarkdown', () => {
  const config = { title: 'Ops', timezone: 'UTC', tasks: [task({ name: 'A | B' }), task({ id: 'x', name: 'X' })] };
  const byTask = { 'nightly-research': [hoursAgo(40, 'ok', { summary: 'pipes | inside', link: 'https://example.com/r' })], x: [] };
  const ov = C.computeOverview(config, byTask, NOW);
  const text = C.renderText(ov);
  assert.match(text, /^Ops · 10\/18 \(Sun\) 05:00 UTC/);
  assert.match(text, /\[SILENT\] A \| B/);
  assert.match(text, /\[NONE\] X/);
  const md = C.renderMarkdown(ov);
  assert.match(md, /\| A \\\| B \| 🟠 Silent \|/);
  assert.match(md, /\[pipes \\\| inside\]\(https:\/\/example\.com\/r\)/);
  assert.match(md, /> \*\*A \\\| B: no record/);
});

// ------------------------------------------------------------ summary
test('buildSummary keeps recent records, newest first; redact strips details', () => {
  const config = { title: 'T', timezone: 'UTC', tasks: [task({ link: 'https://example.com' }), task({ id: 'y' })], secretStuff: 'not copied' };
  const byTask = { 'nightly-research': [hoursAgo(400), hoursAgo(30, 'ok', { link: 'https://e.com/1', metrics: { n: 1 } }), hoursAgo(2, 'warn')] };
  const s = C.buildSummary(config, byTask, { now: NOW, days: 14 });
  assert.equal(s.schema, 'agent-control-tower/summary@1');
  assert.equal(s.records['nightly-research'].length, 2);
  assert.equal(s.records['nightly-research'][0].status, 'warn');
  assert.deepEqual(s.records.y, []);
  assert.equal('secretStuff' in s.config, false);
  const r = C.buildSummary(config, byTask, { now: NOW, redact: true });
  assert.equal(r.redacted, true);
  assert.equal(r.config.tasks[0].link, undefined);
  assert.deepEqual(Object.keys(r.records['nightly-research'][1]).sort(), ['at', 'status', 'summary', 'task', 'v']);
  assert.equal(r.records['nightly-research'][1].summary, '(redacted)');
  // round trip
  const back = C.readSummary(JSON.parse(JSON.stringify(s)));
  assert.equal(back.byTask['nightly-research'].length, 2);
  assert.equal(C.computeOverview(back.config, back.byTask, NOW).tasks[0].state, 'warn');
  assert.throws(() => C.readSummary({ hello: 1 }), /summary\.json/);
});

test('readSummary drops records that fail validation', () => {
  const s = C.buildSummary({ tasks: [task()] }, { 'nightly-research': [hoursAgo(1)] }, { now: NOW });
  s.records['nightly-research'].push({ task: 'nightly-research', at: 'nope', status: 'ok', summary: 'x' });
  const back = C.readSummary(s);
  assert.equal(back.byTask['nightly-research'].length, 1);
  assert.equal(back.invalid, 1);
});

// --------------------------------------------------------------- demo
test('demo data is clearly fake and shows every interesting state', () => {
  const { config, byTask } = C.demoData(NOW);
  assert.ok(C.validateConfig(config).ok);
  for (const id of Object.keys(byTask)) {
    for (const r of byTask[id]) {
      assert.ok(r.summary.startsWith('[demo] '), r.summary);
      assert.ok(C.validateRecord(r).ok, JSON.stringify(r));
    }
  }
  const ov = C.computeOverview(config, byTask, NOW);
  const states = Object.fromEntries(ov.tasks.map((t) => [t.id, t.state]));
  assert.equal(states['pr-triage'], 'fail');
  assert.equal(states['price-watcher'], 'stale');
  assert.equal(states['inbox-digest'], 'warn');
  assert.equal(states['nightly-research'], 'ok');
  assert.equal(states['db-backup'], 'ok');
  assert.equal(states['weekly-report'], 'paused');
  assert.deepEqual(C.demoData(NOW), C.demoData(NOW), 'deterministic');
});
