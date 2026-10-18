# Private repositories

Logs in a private repo stay private. The question is only how you look at them without leaking them or a credential.
All options below need **no token**.

## 1. Watchdog + job summary (recommended, nothing is published)

`templates/workflows/tower-watchdog.yml` (added by `init --workflows`) runs hourly:

- `status --markdown` is written to the run's **job summary**, a table only people with access to the repo can open
  (Actions > tower watchdog > latest run).
- When a task is failing or silent the run exits with code 2 and goes red. GitHub sends its usual failed-workflow
  notification: for scheduled workflows, to the person who last edited the `cron:` line (check Settings >
  Notifications > Actions on that account).
- It runs on GitHub's clock, so it catches agents that never started, which is exactly what an agent-side check can't do.

Agent log pushes count as repository activity, so GitHub's "disable scheduled workflows after 60 days without activity"
rule doesn't kick in while your agents are alive. If every agent dies for 60 days, GitHub will email you about disabling
the watchdog as well.

## 2. Local dashboard

```bash
git clone git@github.com:you/agent-logs.git && cd agent-logs
npx agent-control-tower serve        # http://127.0.0.1:8787, reads tower/ live, binds to localhost only
```

## 3. Pages with redaction

GitHub Pages can publish from a private repo on paid plans, **but the site itself is public** (apart from GitHub
Enterprise Cloud's access-controlled private Pages). If you want a URL anyway:

```yaml
# .github/workflows/tower-pages.yml
- run: npx --yes agent-control-tower@0 build --dir tower --out _site --days 14 --redact
```

`--redact` keeps task ids, names, schedules, times and statuses, and drops summaries, links and metrics. Task names are still
public, so rename revealing ones in `tower.config.json` (`"name": "Job A"`).

## 4. A separate public status repo (needs a token, use with care)

Some people mirror a redacted `summary.json` into a public repo. That needs a credential that can push to the other repo:
use a fine-grained token limited to **that one repo** with contents: write, stored as an Actions secret. Never the
other way around.

## What not to do

- **Don't put a GitHub token in the page, the URL (`?token=`), or `summary.json`.** Anyone who can load the page can read it,
  and URLs end up in browser history, logs and `Referer` headers. A read-only token for a private repo still exposes every
  file in it.
- Don't point `?data=` at an authenticated raw URL (`raw.githubusercontent.com/...?token=...`) for the same reason.
- Don't log secrets into summaries "because the repo is private". Repos change visibility, get forked and get cloned onto
  laptops. The CLI refuses anything that looks like a key on purpose.
