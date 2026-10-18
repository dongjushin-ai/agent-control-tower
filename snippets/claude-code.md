# Snippet: Claude Code (scheduled tasks, cloud sessions, headless `claude -p`)

Paste the block below at the **very end** of the prompt of any Claude Code run that happens without you:
a cloud scheduled task, a `claude -p` call from cron, or a GitHub Actions job running Claude Code.
Change only `<task-id>` and `<OWNER>/<LOG-REPO>`.

Two ways to lay this out:

- **Same repo.** The agent works in the repo that holds `tower/` and commits to `main`. Delete step 1.
- **One log repo for everything (recommended).** Make a small repo (for example `agent-logs`) that holds only `tower/`.
  Every agent clones it shallowly at the end of its run and appends one line. Agents that work on feature branches
  (Claude Code cloud sessions usually do) never mix log commits into their PRs.

```text
## Final step: record this run in the control tower
Do this even if earlier steps failed. Task id: <task-id>

1. Clone the log repo into a fresh folder (it needs push access):
   git clone --depth 1 https://github.com/<OWNER>/<LOG-REPO> /tmp/tower-logs && cd /tmp/tower-logs
   If the folder already exists, run: cd /tmp/tower-logs && git pull --ff-only
2. Record one line and push it:
   npx --yes agent-control-tower@0 log --task <task-id> --status <ok|warn|fail> --summary "<one line, under 120 characters>" --link "<URL of the result, or drop this option>" --push
   - ok = you did everything. warn = you did part of it (say what you skipped). fail = no main result (say which step stopped you and why).
   - Optional numbers: --metric name=number (repeatable), for example --metric prs=4
   - Never put secrets, tokens, passwords, personal data or customer names in the summary or link. The CLI refuses anything that looks like a key.
3. If node or npx is missing, append this JSON line to tower/logs/<task-id>.jsonl yourself (at = current UTC time), then git add, commit and push:
   {"v":1,"task":"<task-id>","at":"2026-01-01T00:00:00Z","status":"ok","summary":"<one line>"}
   If the push is rejected, run git pull --rebase and push again (up to 3 times). Never force-push.
4. If recording fails, still report your real result, and end your reply with: tower: could not record (<one-line reason>)
```

## Notes

- A run that crashes before the last step writes nothing. That is the point: the watchdog
  (`templates/workflows/tower-watchdog.yml`) and the dashboard flag the task as **Silent** once it misses its schedule
  plus a grace period (`everyHours + max(1, everyHours/2)` by default, or `graceHours`).
- The first `log` for a new id adds the task to `tower.config.json` with a 24 h schedule. Pass `--every 6 --name "PR triage"`
  once (or edit the config) if the schedule is different.
- Claude Code cloud sessions need push access to the log repo. Give the repo to the scheduled task the same way you give it
  its working repo.
- Prefer prompts in another language? See [claude-code.ko.md](claude-code.ko.md) for a Korean version.
