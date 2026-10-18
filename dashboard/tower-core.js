/*
 * agent-control-tower core — shared by the CLI (Node) and the dashboard (browser).
 * No dependencies. UMD: `require('./tower-core.js')` in Node, `window.TowerCore` in the browser.
 *
 * - record format (JSON Lines, one line per run): validate, create, parse
 * - secret detection (records usually end up in a git repo, often a public one)
 * - per-task state: ok / warn / fail / stale (silent) / none / paused
 * - last-7-days strip, success rate, coverage (runs recorded vs. runs expected)
 * - summary.json for static hosting, text / markdown renderers, demo data
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TowerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1.0';
  var SCHEMA_VERSION = 1;
  var STATUSES = ['ok', 'warn', 'fail'];
  var STATES = ['fail', 'stale', 'warn', 'none', 'ok', 'paused'];
  var KINDS = ['claude-code', 'llm-agent', 'github-actions', 'cron', 'other'];
  var TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
  var SUMMARY_MAX = 300;
  var MIN = 60 * 1000;
  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  var SEVERITY = { fail: 5, stale: 4, warn: 3, none: 2, ok: 1, paused: 0 };

  // ---------------------------------------------------------------- i18n
  var STRINGS = {
    en: {
      weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      state: { ok: 'Healthy', warn: 'Partial', fail: 'Failed', stale: 'Silent', none: 'No runs yet', paused: 'Paused' },
      status: { ok: 'ok', warn: 'partial', fail: 'failed' },
      justNow: 'just now',
      minAgo: '{n}m ago',
      hourAgo: '{n}h ago',
      dayAgo: '{d}d {h}h ago',
      dayAgoFlat: '{d}d ago',
      durH: '{n}h',
      durD: '{d}d {h}h',
      durDFlat: '{d}d',
      failMsg: '{name}: last run failed ({ago})',
      staleMsg: '{name}: no record for {dur} (expected every {every})',
      noneMsg: '{name}: no runs recorded yet',
      warnMsg: '{name}: last run was partial ({ago})',
      everyH: '{n}h',
      title: 'Agent Control Tower',
      textHeader: '{title} · {time}',
      textLast: 'last {when}',
      textRate: '7d success {rate} ({ok}/{total})',
      textNever: 'never',
      mdHeader: '| Task | State | Last run | 7-day success | Summary |',
      allGood: 'All tasks healthy.'
    },
    ko: {
      weekdays: ['일', '월', '화', '수', '목', '금', '토'],
      state: { ok: '정상', warn: '부분 성공', fail: '실패', stale: '기록 끊김', none: '기록 없음', paused: '꺼짐' },
      status: { ok: '성공', warn: '부분 성공', fail: '실패' },
      justNow: '방금',
      minAgo: '{n}분 전',
      hourAgo: '{n}시간 전',
      dayAgo: '{d}일 {h}시간 전',
      dayAgoFlat: '{d}일 전',
      durH: '{n}시간',
      durD: '{d}일 {h}시간',
      durDFlat: '{d}일',
      failMsg: '{name}: 마지막 실행이 실패했어요 ({ago})',
      staleMsg: '{name}: {dur}째 기록이 없어요 (주기 {every})',
      noneMsg: '{name}: 아직 기록이 없어요',
      warnMsg: '{name}: 마지막 실행이 부분 성공이에요 ({ago})',
      everyH: '{n}시간',
      title: '에이전트 관제탑',
      textHeader: '{title} · {time}',
      textLast: '마지막 {when}',
      textRate: '7일 성공률 {rate} ({ok}/{total})',
      textNever: '없음',
      mdHeader: '| 작업 | 상태 | 마지막 실행 | 7일 성공률 | 요약 |',
      allGood: '모든 작업이 정상이에요.'
    }
  };

  function lang(l) {
    l = String(l || 'en').toLowerCase().slice(0, 2);
    return STRINGS[l] ? l : 'en';
  }
  function tr(l, key, vars) {
    var s = STRINGS[lang(l)][key];
    if (s === undefined) s = STRINGS.en[key];
    if (typeof s !== 'string') return s;
    return s.replace(/\{(\w+)\}/g, function (_, k) {
      return vars && vars[k] !== undefined ? vars[k] : '';
    });
  }

  // ------------------------------------------------------------- secrets
  // Records are committed to git and often published. Refuse anything that looks like a credential.
  var SECRET_PATTERNS = [
    { kind: 'Anthropic/OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
    { kind: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
    { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
    { kind: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
    { kind: 'Stripe key', re: /\b[rs]k_(live|test)_[0-9A-Za-z]{16,}/ },
    { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
    { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { kind: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i },
    { kind: 'password', re: /\b(password|passwd|pwd|비밀번호)\s*[:=]\s*\S+/i },
    { kind: 'credentials in URL', re: /[a-z][a-z0-9+.-]*:\/\/[^\/\s:@]+:[^\/\s@]+@/i }
  ];

  function findSecrets(text) {
    if (typeof text !== 'string') return [];
    var found = [];
    for (var i = 0; i < SECRET_PATTERNS.length; i++) {
      if (SECRET_PATTERNS[i].re.test(text)) found.push(SECRET_PATTERNS[i].kind);
    }
    return found;
  }

  // -------------------------------------------------------------- records
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function parseTime(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return NaN;
    return Date.parse(v);
  }
  function isHttpUrl(v) {
    return typeof v === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(v);
  }

  /** Validate one record. Returns { ok, errors[] }. */
  function validateRecord(rec) {
    var errors = [];
    if (!isPlainObject(rec)) return { ok: false, errors: ['a record must be a JSON object'] };
    if (rec.v !== undefined && rec.v !== SCHEMA_VERSION) errors.push('v must be ' + SCHEMA_VERSION);
    if (typeof rec.task !== 'string' || !TASK_ID_RE.test(rec.task)) {
      errors.push('task must be lowercase letters, digits and dashes, max 48 chars (e.g. nightly-research)');
    }
    if (isNaN(parseTime(rec.at))) errors.push('at must be an ISO 8601 timestamp (e.g. 2026-10-18T02:00:00Z)');
    if (STATUSES.indexOf(rec.status) === -1) errors.push('status must be one of ok, warn, fail');
    if (typeof rec.summary !== 'string' || !rec.summary.trim()) errors.push('summary is empty');
    else {
      if (rec.summary.length > SUMMARY_MAX) errors.push('summary must be at most ' + SUMMARY_MAX + ' characters');
      if (/[\r\n]/.test(rec.summary)) errors.push('summary must be a single line');
    }
    if (rec.link !== undefined && rec.link !== null && rec.link !== '' && !isHttpUrl(rec.link)) {
      errors.push('link must be an http(s) URL');
    }
    if (rec.duration !== undefined && (typeof rec.duration !== 'number' || !isFinite(rec.duration) || rec.duration < 0)) {
      errors.push('duration must be a non-negative number of seconds');
    }
    if (rec.metrics !== undefined) {
      if (!isPlainObject(rec.metrics)) errors.push('metrics must be an object of name: number');
      else {
        Object.keys(rec.metrics).forEach(function (k) {
          if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) errors.push('metric name "' + k + '" must be 1-40 chars of A-Z a-z 0-9 _ . -');
          if (typeof rec.metrics[k] !== 'number' || !isFinite(rec.metrics[k])) errors.push('metrics.' + k + ' must be a number');
        });
      }
    }
    var scan = [rec.summary, rec.link].concat(isPlainObject(rec.metrics) ? Object.keys(rec.metrics) : []);
    var secrets = findSecrets(scan.filter(function (x) { return typeof x === 'string'; }).join(' '));
    if (secrets.length) errors.push('looks like a secret (' + secrets.join(', ') + '); refusing to record it');
    return { ok: errors.length === 0, errors: errors };
  }

  /** Build a record from loose input (validate separately). */
  function makeRecord(input, now) {
    var rec = {
      v: SCHEMA_VERSION,
      task: input.task,
      at: input.at || new Date(now === undefined ? Date.now() : now).toISOString(),
      status: input.status,
      summary: typeof input.summary === 'string' ? input.summary.replace(/\s+/g, ' ').trim() : input.summary
    };
    if (input.link) rec.link = input.link;
    if (input.duration !== undefined && input.duration !== null && input.duration !== '') rec.duration = Number(input.duration);
    if (input.metrics && Object.keys(input.metrics).length) rec.metrics = input.metrics;
    return rec;
  }

  /** JSON Lines text -> { records, errors[{line, message}] }. Broken lines are skipped, never fatal. */
  function parseJsonl(text, expectedTask) {
    var records = [];
    var errors = [];
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        errors.push({ line: i + 1, message: 'not valid JSON' });
        return;
      }
      var res = validateRecord(rec);
      if (!res.ok) {
        errors.push({ line: i + 1, message: res.errors.join('; ') });
        return;
      }
      if (expectedTask && rec.task !== expectedTask) {
        errors.push({ line: i + 1, message: 'task "' + rec.task + '" does not match file name (' + expectedTask + ')' });
        return;
      }
      records.push(rec);
    });
    return { records: records, errors: errors };
  }

  // --------------------------------------------------------------- config
  function validTimezone(tz) {
    if (!tz) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Validate tower.config.json. Returns { ok, errors[] }. */
  function validateConfig(config) {
    var errors = [];
    if (!isPlainObject(config)) return { ok: false, errors: ['config must be a JSON object'] };
    if (config.timezone !== undefined && !validTimezone(config.timezone)) errors.push('timezone "' + config.timezone + '" is not a valid IANA time zone');
    if (!Array.isArray(config.tasks)) errors.push('tasks must be an array');
    else {
      var seen = {};
      config.tasks.forEach(function (t, i) {
        var where = 'tasks[' + i + ']';
        if (!isPlainObject(t)) return errors.push(where + ' must be an object');
        if (typeof t.id !== 'string' || !TASK_ID_RE.test(t.id)) errors.push(where + '.id must be lowercase letters, digits and dashes');
        else if (seen[t.id]) errors.push('duplicate task id "' + t.id + '"');
        else seen[t.id] = true;
        if (t.everyHours !== undefined && !(typeof t.everyHours === 'number' && t.everyHours > 0)) errors.push(where + '.everyHours must be a positive number');
        if (t.graceHours !== undefined && !(typeof t.graceHours === 'number' && t.graceHours >= 0)) errors.push(where + '.graceHours must be a number >= 0');
        if (t.link !== undefined && !isHttpUrl(t.link)) errors.push(where + '.link must be an http(s) URL');
        if (t.source !== undefined && !(isPlainObject(t.source) && isHttpUrl(t.source.url))) errors.push(where + '.source.url must be an http(s) URL');
      });
    }
    return { ok: errors.length === 0, errors: errors };
  }

  // ----------------------------------------------------------------- time
  var dtfCache = {};
  function resolveTz(tz) {
    return validTimezone(tz) ? tz : undefined; // undefined = runtime default
  }
  function zoned(t, tz) {
    var key = tz || '';
    var f = dtfCache[key];
    if (!f) {
      f = dtfCache[key] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    var o = {};
    f.formatToParts(new Date(t)).forEach(function (p) {
      o[p.type] = p.value;
    });
    var y = +o.year, mo = +o.month, d = +o.day;
    return { y: y, mo: mo, d: d, h: +o.hour % 24, mi: +o.minute, wd: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
  }
  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }
  function dateKey(t, tz) {
    var p = zoned(t, tz);
    return p.y + '-' + pad(p.mo) + '-' + pad(p.d);
  }
  function tzLabel(tz) {
    if (!tz) {
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {
        tz = '';
      }
    }
    return tz || 'local';
  }
  function formatTime(t, tz, l) {
    var p = zoned(t, tz);
    var wd = tr(l, 'weekdays')[p.wd];
    return p.mo + '/' + p.d + ' (' + wd + ') ' + pad(p.h) + ':' + pad(p.mi);
  }
  function formatAgo(ms, l) {
    if (!(ms > 0)) ms = 0;
    var min = Math.floor(ms / MIN);
    if (min < 1) return tr(l, 'justNow');
    if (min < 60) return tr(l, 'minAgo', { n: min });
    var h = Math.floor(min / 60);
    if (h < 48) return tr(l, 'hourAgo', { n: h });
    var d = Math.floor(h / 24);
    return h % 24 ? tr(l, 'dayAgo', { d: d, h: h % 24 }) : tr(l, 'dayAgoFlat', { d: d });
  }
  function formatDuration(ms, l) {
    var h = Math.floor(ms / HOUR);
    if (h < 48) return tr(l, 'durH', { n: h });
    var d = Math.floor(h / 24);
    return h % 24 ? tr(l, 'durD', { d: d, h: h % 24 }) : tr(l, 'durDFlat', { d: d });
  }
  function formatEvery(hours, l) {
    if (hours < 1) return Math.round(hours * 60) + 'm';
    return tr(l, 'everyH', { n: +hours.toFixed(2) });
  }

  // ---------------------------------------------------------------- state
  /** How long a task may stay quiet before it counts as silent: every + grace (default max(1h, every/2)). */
  function staleAfterMs(task) {
    task = task || {};
    var every = task.everyHours > 0 ? task.everyHours : 24;
    var grace = typeof task.graceHours === 'number' && task.graceHours >= 0 ? task.graceHours : Math.max(1, every / 2);
    return (every + grace) * HOUR;
  }

  function computeTaskView(task, records, now, opts) {
    now = now === undefined ? Date.now() : now;
    opts = opts || {};
    var tz = resolveTz(opts.timezone);
    var every = task.everyHours > 0 ? task.everyHours : 24;
    var enabled = task.enabled !== false;

    var sorted = (records || [])
      .map(function (r) {
        return { rec: r, t: parseTime(r.at) };
      })
      .filter(function (x) {
        return !isNaN(x.t) && x.t <= now + 5 * MIN; // drop future timestamps (clock skew > 5 min)
      })
      .sort(function (a, b) {
        return b.t - a.t;
      });

    var last = sorted[0] || null;
    var state;
    if (!enabled) state = 'paused';
    else if (!last) state = 'none';
    else if (last.rec.status === 'fail') state = 'fail';
    else if (now - last.t > staleAfterMs(task)) state = 'stale';
    else if (last.rec.status === 'warn') state = 'warn';
    else state = 'ok';

    // Last 7 calendar days (today included) in the configured time zone.
    var today = zoned(now, tz);
    var todayUtc = Date.UTC(today.y, today.mo - 1, today.d);
    var days = [];
    var index = {};
    for (var i = 6; i >= 0; i--) {
      var dt = new Date(todayUtc - i * DAY);
      var key = dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
      index[key] = days.length;
      days.push({ key: key, label: dt.getUTCMonth() + 1 + '/' + dt.getUTCDate(), wd: dt.getUTCDay(), isToday: i === 0, ok: 0, warn: 0, fail: 0, total: 0 });
    }
    var sinceMidnight = (today.h * 60 + today.mi) * MIN;
    var windowStart = now - sinceMidnight - 6 * DAY; // approximate across DST, good enough for "expected runs"
    var week = { total: 0, ok: 0, warn: 0, fail: 0 };
    sorted.forEach(function (x) {
      var idx = index[dateKey(x.t, tz)];
      if (idx === undefined) return;
      days[idx][x.rec.status]++;
      days[idx].total++;
      week[x.rec.status]++;
      week.total++;
    });
    var first = sorted.length ? sorted[sorted.length - 1].t : null;
    var everyMs = every * HOUR;
    var expected = null;
    if (enabled) {
      if (first !== null && first > windowStart) expected = Math.floor((now - first) / everyMs) + 1;
      else expected = Math.floor((now - windowStart) / everyMs);
      expected = Math.max(1, expected);
    }
    week.rate = week.total ? week.ok / week.total : null;
    week.expected = expected;
    week.coverage = expected === null ? null : Math.min(1, week.total / expected);
    var perDay = Math.max(1, 24 / every);
    days.forEach(function (d) {
      d.fill = Math.min(1, d.total / perDay);
    });

    return {
      id: task.id,
      name: task.name || task.id,
      kind: task.kind || '',
      schedule: task.schedule || '',
      link: isHttpUrl(task.link) ? task.link : '',
      everyHours: every,
      enabled: enabled,
      state: state,
      severity: SEVERITY[state],
      last: last ? last.rec : null,
      lastAt: last ? last.t : null,
      lastAgoMs: last ? now - last.t : null,
      silentForMs: state === 'stale' ? now - last.t : null,
      days: days,
      perDay: perDay,
      week: week,
      recent: sorted.slice(0, 10).map(function (x) {
        return x.rec;
      })
    };
  }

  function computeOverview(config, recordsByTask, now, opts) {
    now = now === undefined ? Date.now() : now;
    opts = opts || {};
    var l = lang(opts.lang || config.locale);
    var tz = opts.timezone || config.timezone;
    var tasks = (config.tasks || []).map(function (t) {
      return computeTaskView(t, recordsByTask[t.id] || [], now, { timezone: tz });
    });
    tasks.sort(function (a, b) {
      return b.severity - a.severity || a.name.localeCompare(b.name);
    });
    var counts = { ok: 0, warn: 0, fail: 0, stale: 0, none: 0, paused: 0 };
    var week = { total: 0, ok: 0 };
    tasks.forEach(function (v) {
      counts[v.state]++;
      if (v.enabled) {
        week.total += v.week.total;
        week.ok += v.week.ok;
      }
    });
    var issues = tasks
      .filter(function (v) {
        return v.state === 'fail' || v.state === 'stale' || v.state === 'warn' || v.state === 'none';
      })
      .map(function (v) {
        var msg;
        if (v.state === 'fail') msg = tr(l, 'failMsg', { name: v.name, ago: formatAgo(v.lastAgoMs, l) });
        else if (v.state === 'stale') msg = tr(l, 'staleMsg', { name: v.name, dur: formatDuration(v.silentForMs, l), every: formatEvery(v.everyHours, l) });
        else if (v.state === 'warn') msg = tr(l, 'warnMsg', { name: v.name, ago: formatAgo(v.lastAgoMs, l) });
        else msg = tr(l, 'noneMsg', { name: v.name });
        return { id: v.id, name: v.name, state: v.state, message: msg };
      });
    return {
      now: now,
      lang: l,
      timezone: resolveTz(tz),
      title: config.title || tr(l, 'title'),
      tasks: tasks,
      counts: counts,
      issues: issues,
      problems: issues.filter(function (p) {
        return p.state === 'fail' || p.state === 'stale';
      }),
      weekRate: week.total ? week.ok / week.total : null,
      weekTotal: week.total
    };
  }

  /** Which states make `tower status` exit non-zero. */
  function failingTasks(overview, failOn) {
    failOn = failOn || ['fail', 'stale'];
    return overview.tasks.filter(function (v) {
      return failOn.indexOf(v.state) > -1;
    });
  }

  // ------------------------------------------------------------ renderers
  function pct(x) {
    return x === null || x === undefined ? '-' : Math.round(x * 100) + '%';
  }

  function renderText(overview) {
    var l = overview.lang;
    var tag = { ok: '[ OK ]', warn: '[WARN]', fail: '[FAIL]', stale: '[SILENT]', none: '[NONE]', paused: '[PAUSE]' };
    var lines = [tr(l, 'textHeader', { title: overview.title, time: formatTime(overview.now, overview.timezone, l) + ' ' + tzLabel(overview.timezone) })];
    overview.tasks.forEach(function (v) {
      var when = v.lastAt ? formatAgo(v.lastAgoMs, l) : tr(l, 'textNever');
      lines.push(
        tag[v.state] + ' ' + v.name + ' · ' + tr(l, 'textLast', { when: when }) + ' · ' +
          tr(l, 'textRate', { rate: pct(v.week.rate), ok: v.week.ok, total: v.week.total }) +
          (v.last ? '\n        ' + v.last.summary : '')
      );
    });
    if (overview.problems.length) {
      lines.push('');
      overview.problems.forEach(function (p) {
        lines.push('! ' + p.message);
      });
    }
    return lines.join('\n');
  }

  function mdCell(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  }

  /** Markdown, e.g. for $GITHUB_STEP_SUMMARY. */
  function renderMarkdown(overview) {
    var l = overview.lang;
    var icon = { ok: '🟢', warn: '🟡', fail: '🔴', stale: '🟠', none: '⚪', paused: '⏸️' };
    var out = ['### ' + mdCell(overview.title), ''];
    if (overview.problems.length) {
      overview.problems.forEach(function (p) {
        out.push('> **' + mdCell(p.message) + '**');
      });
      out.push('');
    } else {
      out.push(tr(l, 'allGood'), '');
    }
    out.push(tr(l, 'mdHeader'), '| --- | --- | --- | --- | --- |');
    overview.tasks.forEach(function (v) {
      var when = v.lastAt ? formatTime(v.lastAt, overview.timezone, l) + ' (' + formatAgo(v.lastAgoMs, l) + ')' : '-';
      var summary = v.last ? (v.last.link ? '[' + mdCell(v.last.summary) + '](' + v.last.link + ')' : mdCell(v.last.summary)) : '';
      out.push('| ' + mdCell(v.name) + ' | ' + icon[v.state] + ' ' + tr(l, 'state')[v.state] + ' | ' + mdCell(when) + ' | ' + pct(v.week.rate) + ' (' + v.week.ok + '/' + v.week.total + ') | ' + summary + ' |');
    });
    out.push('', '<sub>' + tzLabel(overview.timezone) + ' · agent-control-tower ' + VERSION + '</sub>');
    return out.join('\n');
  }

  // -------------------------------------------------------- summary.json
  /**
   * One file with everything the dashboard needs, for static hosting (GitHub Pages).
   * redact: keep only task, time and status (no summaries, links or metrics).
   */
  function buildSummary(config, recordsByTask, opts) {
    opts = opts || {};
    var now = opts.now === undefined ? Date.now() : opts.now;
    var days = opts.days > 0 ? opts.days : 14;
    var cutoff = now - days * DAY;
    var tasks = (config.tasks || []).map(function (t) {
      var copy = {};
      ['id', 'name', 'kind', 'schedule', 'everyHours', 'graceHours', 'enabled', 'link'].forEach(function (k) {
        if (t[k] !== undefined) copy[k] = t[k];
      });
      if (opts.redact) delete copy.link;
      return copy;
    });
    var records = {};
    tasks.forEach(function (t) {
      var list = (recordsByTask[t.id] || []).filter(function (r) {
        return parseTime(r.at) >= cutoff;
      });
      // newest first so the page can show something even if the file is cut short
      list.sort(function (a, b) {
        return parseTime(b.at) - parseTime(a.at);
      });
      records[t.id] = list.map(function (r) {
        if (!opts.redact) return r;
        return { v: r.v || SCHEMA_VERSION, task: r.task, at: r.at, status: r.status, summary: '(redacted)' };
      });
    });
    var out = {
      schema: 'agent-control-tower/summary@1',
      generatedAt: new Date(now).toISOString(),
      generator: 'agent-control-tower ' + VERSION,
      redacted: Boolean(opts.redact),
      config: { title: config.title, timezone: config.timezone, locale: config.locale, tasks: tasks },
      records: records
    };
    if (opts.demo) out.demo = true;
    return out;
  }

  function readSummary(summary) {
    if (!isPlainObject(summary) || !isPlainObject(summary.config) || !isPlainObject(summary.records)) {
      throw new Error('not an agent-control-tower summary.json');
    }
    var byTask = {};
    var errors = 0;
    Object.keys(summary.records).forEach(function (id) {
      byTask[id] = (summary.records[id] || []).filter(function (r) {
        var ok = validateRecord(r).ok;
        if (!ok) errors++;
        return ok;
      });
    });
    return { config: summary.config, byTask: byTask, invalid: errors, generatedAt: summary.generatedAt, redacted: !!summary.redacted, demo: !!summary.demo };
  }

  // ------------------------------------------------------------ demo data
  // Fake data for screenshots and the live demo. Every summary starts with "[demo]".
  var DEMO_TASKS = [
    { id: 'nightly-research', name: 'Nightly research agent', kind: 'claude-code', schedule: 'daily 02:00 · cloud scheduled task', everyHours: 24 },
    { id: 'pr-triage', name: 'PR triage bot', kind: 'github-actions', schedule: 'every 6h · GitHub Actions cron', everyHours: 6 },
    { id: 'price-watcher', name: 'Price watcher', kind: 'claude-code', schedule: 'every 4h · headless claude -p', everyHours: 4 },
    { id: 'inbox-digest', name: 'Inbox digest', kind: 'llm-agent', schedule: 'daily 07:30 · custom LLM agent', everyHours: 24 },
    { id: 'db-backup', name: 'Postgres backup', kind: 'cron', schedule: 'hourly · crontab', everyHours: 1 },
    { id: 'weekly-report', name: 'Weekly report', kind: 'llm-agent', schedule: 'Mondays 09:00', everyHours: 168, enabled: false }
  ];
  var DEMO_TEXT = {
    'nightly-research': {
      ok: ['Read 14 new papers, wrote 3 notes, opened PR #212', 'Summarized 9 sources into notes/2026-10.md', 'Updated the reading list (5 added, 2 archived)'],
      warn: ['Finished notes, but 2 of 11 sources timed out'],
      fail: ['Stopped at step 2: search tool returned 0 results']
    },
    'pr-triage': {
      ok: ['Labeled 6 PRs, requested review on 2', 'Labeled 3 PRs, closed 1 stale PR', 'No new PRs; checked 12 open ones'],
      warn: ['Labeled 4 PRs; skipped 2 with merge conflicts'],
      fail: ['GitHub API rate-limited (403) after 12 PRs']
    },
    'price-watcher': {
      ok: ['Checked 42 products, 3 price drops found', 'Checked 42 products, no changes'],
      warn: ['2 shop pages changed layout, 40/42 checked'],
      fail: ['All requests blocked by bot protection']
    },
    'inbox-digest': {
      ok: ['Digest sent: 18 threads, 4 need replies', 'Digest sent: 11 threads, 1 needs a reply'],
      warn: ['Digest sent without the calendar section (auth expired)'],
      fail: ['Mail API returned 500, no digest sent']
    },
    'db-backup': {
      ok: ['exit 0 in 41s', 'exit 0 in 38s', 'exit 0 in 44s'],
      warn: ['exit 0 in 312s (slow)'],
      fail: ['exit 1 in 3s: pg_dump: connection refused']
    }
  };

  function demoData(now) {
    now = now === undefined ? Date.now() : now;
    var seed = 20261018;
    function rand() {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    }
    function pick(arr) {
      return arr[Math.floor(rand() * arr.length)];
    }
    var byTask = {};
    DEMO_TASKS.forEach(function (t) {
      var list = [];
      byTask[t.id] = list;
      if (t.enabled === false) return;
      var text = DEMO_TEXT[t.id];
      var everyMs = t.everyHours * HOUR;
      // price-watcher went silent 19 hours ago: the agent died without writing anything
      var until = t.id === 'price-watcher' ? now - 19 * HOUR : now;
      var start = now - 9 * DAY;
      for (var at = until - 0.35 * everyMs; at > start; at -= everyMs) {
        var r = rand();
        var status = r < 0.06 ? 'fail' : r < 0.15 ? 'warn' : 'ok';
        var rec = { v: SCHEMA_VERSION, task: t.id, at: new Date(Math.round(at / 1000) * 1000).toISOString(), status: status, summary: '[demo] ' + pick(text[status]) };
        if (t.kind === 'cron') rec.duration = 38 + Math.round(rand() * 8);
        if (t.id === 'nightly-research' && status !== 'fail') rec.metrics = { sources: 9 + Math.round(rand() * 6), notes: 2 + Math.round(rand() * 3) };
        list.push(rec);
      }
      if (t.id === 'pr-triage' && list.length) {
        list[0].status = 'fail';
        list[0].summary = '[demo] ' + text.fail[0];
        list[0].link = 'https://github.com/dongjushin-ai/agent-control-tower/actions';
      }
      if (t.id === 'inbox-digest' && list.length) {
        list[0].status = 'warn';
        list[0].summary = '[demo] ' + text.warn[0];
      }
      if (t.id === 'nightly-research' && list.length) {
        list[0].status = 'ok';
        list[0].summary = '[demo] ' + text.ok[0];
        list[0].link = 'https://github.com/dongjushin-ai/agent-control-tower';
      }
      if (t.id === 'db-backup' && list.length) list[0].status = 'ok';
    });
    return {
      config: { title: 'Agent Control Tower — demo', timezone: undefined, tasks: DEMO_TASKS.map(function (t) { return Object.assign({}, t); }) },
      byTask: byTask
    };
  }

  return {
    VERSION: VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUSES: STATUSES,
    STATES: STATES,
    KINDS: KINDS,
    TASK_ID_RE: TASK_ID_RE,
    STRINGS: STRINGS,
    lang: lang,
    tr: tr,
    findSecrets: findSecrets,
    isHttpUrl: isHttpUrl,
    parseTime: parseTime,
    validateRecord: validateRecord,
    makeRecord: makeRecord,
    parseJsonl: parseJsonl,
    validTimezone: validTimezone,
    validateConfig: validateConfig,
    staleAfterMs: staleAfterMs,
    computeTaskView: computeTaskView,
    computeOverview: computeOverview,
    failingTasks: failingTasks,
    renderText: renderText,
    renderMarkdown: renderMarkdown,
    buildSummary: buildSummary,
    readSummary: readSummary,
    demoData: demoData,
    dateKey: dateKey,
    tzLabel: tzLabel,
    formatTime: formatTime,
    formatAgo: formatAgo,
    formatDuration: formatDuration,
    formatEvery: formatEvery
  };
});
