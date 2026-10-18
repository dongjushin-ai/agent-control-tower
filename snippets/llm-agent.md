# Snippet: any other LLM agent

Works with any agent that can run a shell command (Codex CLI, Aider, OpenHands, Goose, your own tool-calling loop),
and with agents that can't, by recording from the wrapper that starts them.

## A. The agent has a shell tool

Paste at the end of its instructions (same block as the Claude Code one, nothing in it is Claude-specific):

```text
## Final step: record this run in the control tower
Do this even if earlier steps failed. Task id: <task-id>
From the repository that contains tower/tower.config.json, run:
  npx --yes agent-control-tower@0 log --task <task-id> --status <ok|warn|fail> --summary "<one line, under 120 characters>" --push
ok = did everything. warn = did part of it (say what was skipped). fail = no main result (say which step failed and why).
Never put secrets, tokens, passwords or personal data in the summary. If node is missing, append
{"v":1,"task":"<task-id>","at":"<current UTC time, ISO 8601>","status":"ok","summary":"<one line>"}
to tower/logs/<task-id>.jsonl, then commit and push. If recording fails, say so in the last line of your reply.
```

## B. Record from the wrapper (more reliable)

The model can forget the last step; the process that launched it can't. Let the wrapper decide the status
from what the agent returned, so a crash still ends up as `fail` instead of nothing.

```python
# tower_log.py: tiny helper, no dependencies besides git + node on PATH
import subprocess

def tower_log(task, status, summary, link=None, push=True, **metrics):
    cmd = ["npx", "--yes", "agent-control-tower@0", "log", "--task", task,
           "--status", status, "--summary", summary[:280]]
    if link:
        cmd += ["--link", link]
    for name, value in metrics.items():
        cmd += ["--metric", f"{name}={value}"]
    if push:
        cmd.append("--push")
    return subprocess.run(cmd, check=False).returncode == 0

# usage
try:
    result = run_my_agent()                      # your code
    status = "ok" if result.complete else "warn"
    tower_log("inbox-digest", status, result.one_line_summary, threads=result.count)
except Exception as e:
    tower_log("inbox-digest", "fail", f"crashed: {type(e).__name__}")
    raise
```

Node/TypeScript wrappers can call the CLI the same way with `child_process.execFile`.

## C. No Node at all

A record is one line of JSON. Append it, commit, push:

```bash
printf '{"v":1,"task":"%s","at":"%s","status":"%s","summary":"%s"}\n' \
  inbox-digest "$(date -u +%Y-%m-%dT%H:%M:%SZ)" ok "Digest sent: 11 threads" >> tower/logs/inbox-digest.jsonl
git add tower/logs && git commit -m "tower: inbox-digest ok" && git push
```

Keep the summary free of `"` and `\` when you build JSON by hand, or use `jq -nc` to build the line.
